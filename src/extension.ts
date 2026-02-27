import * as vscode from 'vscode';
import { ConfigManager } from './config';

export function activate(context: vscode.ExtensionContext) {
    ConfigManager.init();

    const provider = new RefReadWriteProvider();
    const treeView = vscode.window.createTreeView('refWriteView', {
        treeDataProvider: provider,
        showCollapseAll: true
    });

    let analyzeCmd = vscode.commands.registerCommand('ref-read-write-detector.analyze', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
        if (wordRange) {
            const varName = editor.document.getText(wordRange);
            await provider.analyzeAndStore(varName, editor);
        }
        vscode.commands.executeCommand('refWriteView.focus');
    });

    let clearCmd = vscode.commands.registerCommand('ref-read-write-detector.clear', () => {
        provider.clearAll();
    });

    let removeCmd = vscode.commands.registerCommand('ref-read-write-detector.internal.removeHistoryGroup', (node: vscode.TreeItem) => {
        if (node instanceof HistoryGroupNode) {
            provider.removeTreeNode(node);
            provider.refresh();
        }
    });

    context.subscriptions.push(analyzeCmd, clearCmd, removeCmd, treeView);
}

type RefNode = HistoryGroupNode | FileGroupNode | CategoryNode | ReferenceItem;

class RefReadWriteProvider implements vscode.TreeDataProvider<RefNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<RefNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private history: HistoryGroupNode[] = [];

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }
    clearAll(): void { this.history = []; this.refresh(); }
    getTreeItem(element: RefNode): vscode.TreeItem { return element; }

    async analyzeAndStore(varName: string, editor: vscode.TextEditor) {
        const locations = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', editor.document.uri, editor.selection.active);
        if (!locations) return;

        const group = new HistoryGroupNode(varName, editor.document.languageId, locations);
        await group.buildFileGroups();
        this.history.unshift(group);
        this.refresh();
    }

    async getChildren(element?: RefNode): Promise<RefNode[]> {
        if (!element) return this.history;
        if (element instanceof HistoryGroupNode) return element.fileGroups;
        if (element instanceof FileGroupNode) return element.categories;
        if (element instanceof CategoryNode) return element.references;
        return [];
    }

    async removeTreeNode(node: HistoryGroupNode) {
        const indexToRemove = this.history.indexOf(node);
        if (indexToRemove !== -1) {
            this.history.splice(indexToRemove, 1);
        }
    }
}

class HistoryGroupNode extends vscode.TreeItem {
    public fileGroups: FileGroupNode[] = [];
    constructor(public readonly varName: string, public readonly langId: string, private locations: vscode.Location[]) {
        super(`${vscode.l10n.t('history.title')}: ${varName}`, vscode.TreeItemCollapsibleState.Expanded);
        this.iconPath = new vscode.ThemeIcon('history', new vscode.ThemeColor('charts.purple'));
        this.description = `[${langId}]`;

        this.tooltip = new vscode.MarkdownString(`**${varName}** (${langId})\n\n${vscode.l10n.t('history.removeTooltip')}`);
        this.tooltip.supportHtml = true;

        this.contextValue = 'historyGroup';
    }

    async buildFileGroups() {
        const fileMap = new Map<string, vscode.Location[]>();
        for (const loc of this.locations) {
            const path = loc.uri.fsPath;
            if (!fileMap.has(path)) fileMap.set(path, []);
            fileMap.get(path)!.push(loc);
        }
        const defaultExpand = ConfigManager.defaultExpandAllFileGroup;
        for (const [path, locs] of fileMap) {
            const fileGroup = new FileGroupNode(path, this.varName, this.langId, defaultExpand);
            await fileGroup.calculate(locs);
            this.fileGroups.push(fileGroup);
        }
    }
}

class FileGroupNode extends vscode.TreeItem {
    public categories: CategoryNode[] = [];
    constructor(public readonly filePath: string, private varName: string, private langId: string, private defaultExpand: boolean) {
        const fileName = filePath.split('/').pop() || filePath;
        super(fileName, defaultExpand ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        this.resourceUri = vscode.Uri.file(filePath);
        this.iconPath = vscode.ThemeIcon.File;
    }

    async calculate(locations: vscode.Location[]) {
        // 初始化分类桶
        const buckets: any = { direct: [], prop: [], setter: [], method: [], value: [] };
        const isObjC = this.langId.startsWith('objective');

        // 预编译正则所需的变量，避免循环内重复计算
        const varName = this.varName;
        const capVarName = varName.charAt(0).toUpperCase() + varName.slice(1);

        // 定义修改性动词前缀 (用于猜测方法意图)
        const mutatingPrefixes = ConfigManager.mutatingPrefixes;
        const mutatingPrompt = ConfigManager.mutatingPrompt;

        // 1. [Direct Write] 匹配: var = ... 或 var += ...
        const directWriteRegex = new RegExp(`(?<!\\.|@)\\b${varName}\\b\\s*([-+*/%&|^]?=(?!=)|\\+\\+|--)`);

        // 2. [Dot Setter] 匹配: .var = ... 
        const dotSetterRegex = new RegExp(`\\.\\b${varName}\\b\\s*([-+*/%&|^]?=(?!=)|\\+\\+|--)`);

        // 3. [Chained Modify] 匹配: var.child = ... 
        const chainedModifyRegex = new RegExp(`(?:\\.|^|\\s)\\b${varName}\\b\\.[a-zA-Z0-9_]+\\s*([-+*/%&|^]?=(?!=)|\\+\\+|--)`);

        // 4. [Method Receiver] 匹配: [var method] 或 [self.var method]
        const methodReceiverRegex = new RegExp(`\\[\\s*(?:[\\w]+\\.)?\\b${varName}\\b\\s+([a-zA-Z0-9_]+)`);

        // 5. [Explicit Setter] 匹配: setVar:
        const explicitSetterName = `set${capVarName}:`;

        for (const loc of locations) {
            const doc = await vscode.workspace.openTextDocument(loc.uri);
            const lineText = doc.lineAt(loc.range.start.line).text;
            const trimmedText = lineText.trim();

            // 跳过声明行
            if (trimmedText.startsWith('@implementation') || trimmedText.startsWith('@interface') || trimmedText.startsWith('@property')) continue;

            const item = new ReferenceItem(trimmedText, loc);
            let handled = false;

            if (isObjC) {
                // 预处理：去除注释和字符串内容
                const cleanLine = lineText.replace(/\/\/.*|\/\*[\s\S]*?\*\/|@"[^"]*"/g, '');

                // A. 显式 Setter 方法 或 点语法 Setter
                if (cleanLine.includes(explicitSetterName) || dotSetterRegex.test(cleanLine)) {
                    item.iconPath = new vscode.ThemeIcon('symbol-interface', new vscode.ThemeColor('charts.yellow'));
                    buckets.setter.push(item);
                    handled = true;
                }
                // B. 直接变量赋值 (Direct Write)
                else if (directWriteRegex.test(cleanLine)) {
                    item.iconPath = new vscode.ThemeIcon('edit', new vscode.ThemeColor('debugIcon.stepOverForeground'));
                    buckets.direct.push(item);
                    handled = true;
                }
                // C. 链式属性修改 (Chained Modification)
                else if (chainedModifyRegex.test(cleanLine)) {
                    item.iconPath = new vscode.ThemeIcon('symbol-property', new vscode.ThemeColor('charts.orange'));
                    buckets.prop.push(item);
                    handled = true;
                }
                // D. 方法调用 (作为接收者)
                else {
                    const methodMatch = cleanLine.match(methodReceiverRegex);
                    if (methodMatch) {
                        const methodName = methodMatch[1];
                        const isMutating = mutatingPrefixes.some(prefix => methodName.toLowerCase().startsWith(prefix));

                        if (isMutating) {
                            item.iconPath = new vscode.ThemeIcon('symbol-event', new vscode.ThemeColor('charts.red'));
                            item.label = `${mutatingPrompt}${item.label}`;
                        } else {
                            item.iconPath = new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('debugIcon.stepIntoForeground'));
                        }
                        buckets.method.push(item);
                        handled = true;
                    }
                }
            }

            // Fallback
            if (!handled) {
                if (new RegExp(`\\b${this.varName}\\b\\s*=(?!=)`).test(lineText)) {
                    item.iconPath = new vscode.ThemeIcon('edit');
                    buckets.direct.push(item);
                } else {
                    item.iconPath = new vscode.ThemeIcon('book', new vscode.ThemeColor('charts.blue'));
                    buckets.value.push(item);
                }
            }
        }

        this.categories = [];

        // 定义分类配置映射
        const categoryDefinitions = [
            {
                key: 'direct',
                items: buckets.direct,
                label: vscode.l10n.t('category.direct')
            },
            {
                key: 'prop',
                items: buckets.prop,
                label: vscode.l10n.t('category.prop')
            },
            {
                key: 'setter',
                items: buckets.setter,
                label: vscode.l10n.t('category.setter')
            },
            {
                key: 'method',
                items: buckets.method,
                label: vscode.l10n.t('category.method')
            },
            {
                key: 'value',
                items: buckets.value,
                label: vscode.l10n.t('category.value')
            }
        ];

        // 遍历配置，仅添加有数据的分类
        for (const def of categoryDefinitions) {
            if (def.items.length > 0) {
                const labelText = def.label;
                const finalLabel = `${labelText} - ${def.items.length}`;
                this.categories.push(new CategoryNode(finalLabel, def.key, def.items));
            }
        }
    }
}

class CategoryNode extends vscode.TreeItem {
    constructor(public readonly label: string, public readonly type: string, public readonly references: ReferenceItem[]) {
        super(label, references.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        const iconMap: any = {
            direct: { id: 'record-keys', color: 'debugIcon.stepOverForeground' },
            prop: { id: 'symbol-property', color: 'charts.orange' },
            setter: { id: 'symbol-interface', color: 'charts.yellow' },
            method: { id: 'symbol-method', color: 'debugIcon.stepIntoForeground' },
            value: { id: 'book', color: 'charts.blue' }
        };
        const config = iconMap[type];
        this.iconPath = new vscode.ThemeIcon(config.id, new vscode.ThemeColor(config.color));
    }
}

class ReferenceItem extends vscode.TreeItem {
    constructor(public label: string, public readonly location: vscode.Location) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = `L${this.location.range.start.line + 1}`;
        this.command = { command: 'vscode.open', title: "Jump", arguments: [this.location.uri, { selection: this.location.range }] };
    }
}