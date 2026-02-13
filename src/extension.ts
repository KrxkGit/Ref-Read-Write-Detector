import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
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

    context.subscriptions.push(analyzeCmd, clearCmd, treeView);
}

type RefNode = HistoryGroupNode | FileGroupNode | CategoryNode | ReferenceItem;

class RefReadWriteProvider implements vscode.TreeDataProvider<RefNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<RefNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private history: HistoryGroupNode[] = [];

    refresh(): void { this._onDidChangeTreeData.fire(); }
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
}

class HistoryGroupNode extends vscode.TreeItem {
    public fileGroups: FileGroupNode[] = [];
    constructor(public readonly varName: string, public readonly langId: string, private locations: vscode.Location[]) {
        // 使用 l10n 或 package.nls 中的前缀
        super(`分析: ${varName}`, vscode.TreeItemCollapsibleState.Expanded);
        this.iconPath = new vscode.ThemeIcon('history', new vscode.ThemeColor('charts.purple'));
        this.description = `[${langId}]`;
    }

    async buildFileGroups() {
        const fileMap = new Map<string, vscode.Location[]>();
        for (const loc of this.locations) {
            const path = loc.uri.fsPath;
            if (!fileMap.has(path)) fileMap.set(path, []);
            fileMap.get(path)!.push(loc);
        }
        for (const [path, locs] of fileMap) {
            const fileGroup = new FileGroupNode(path, this.varName, this.langId);
            await fileGroup.calculate(locs);
            this.fileGroups.push(fileGroup);
        }
    }
}

class FileGroupNode extends vscode.TreeItem {
    public categories: CategoryNode[] = [];
    constructor(public readonly filePath: string, private varName: string, private langId: string) {
        const fileName = filePath.split('/').pop() || filePath;
        super(fileName, vscode.TreeItemCollapsibleState.Expanded);
        this.resourceUri = vscode.Uri.file(filePath);
        this.iconPath = vscode.ThemeIcon.File;
    }

    async calculate(locations: vscode.Location[]) {
        const buckets: any = { direct: [], prop: [], setter: [], method: [], value: [] };
        const isObjC = this.langId.startsWith('objective');

        for (const loc of locations) {
            const doc = await vscode.workspace.openTextDocument(loc.uri);
            const lineText = doc.lineAt(loc.range.start.line).text;
            const trimmedText = lineText.trim();
            if (trimmedText.startsWith('@implementation') || trimmedText.startsWith('@interface')) continue;

            const item = new ReferenceItem(trimmedText, loc);
            let handled = false;

            if (isObjC) {
                const varName = this.varName;
                const isDirect = new RegExp(`\\b${varName}\\b\\s*=[^=]`).test(lineText);
                const isPropChain = new RegExp(`\\b${varName}\\b(\\.[a-zA-Z0-9_]+)+\\s*=[^=]`).test(lineText);
                const setterName = `set${varName.charAt(0).toUpperCase()}${varName.slice(1)}:`;
                const isSetter = lineText.includes(setterName);
                const isMethodCall = new RegExp(`\\[.*\\b${varName}\\b.*\\s+[a-zA-Z0-9_]+(:|\\])`).test(lineText);

                if (isDirect) { item.iconPath = new vscode.ThemeIcon('record-keys', new vscode.ThemeColor('debugIcon.stepOverForeground')); buckets.direct.push(item); handled = true; }
                else if (isPropChain) { item.iconPath = new vscode.ThemeIcon('symbol-property', new vscode.ThemeColor('charts.orange')); buckets.prop.push(item); handled = true; }
                else if (isSetter) { item.iconPath = new vscode.ThemeIcon('symbol-interface', new vscode.ThemeColor('charts.yellow')); buckets.setter.push(item); handled = true; }
                else if (isMethodCall) { item.iconPath = new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('debugIcon.stepIntoForeground')); buckets.method.push(item); handled = true; }
            }

            if (!handled) {
                if (new RegExp(`\\b${this.varName}\\b\\s*=[^=]`).test(lineText)) {
                    item.iconPath = new vscode.ThemeIcon('record-keys'); buckets.direct.push(item);
                } else {
                    item.iconPath = new vscode.ThemeIcon('book', new vscode.ThemeColor('charts.blue')); buckets.value.push(item);
                }
            }
        }

        // 此处可以根据 VS Code 语言设置选择显示中文还是英文标签
        const useZh = vscode.env.language === 'zh-cn';
        this.categories = [
            new CategoryNode(useZh ? `变量赋值 - ${buckets.direct.length}` : `Direct Writes - ${buckets.direct.length}`, 'direct', buckets.direct),
            new CategoryNode(useZh ? `属性/链式修改 - ${buckets.prop.length}` : `Property/Chained - ${buckets.prop.length}`, 'prop', buckets.prop),
            new CategoryNode(useZh ? `方法调用 (Setter) - ${buckets.setter.length}` : `Setter Calls - ${buckets.setter.length}`, 'setter', buckets.setter),
            new CategoryNode(useZh ? `消息发送 (Instance) - ${buckets.method.length}` : `Instance Methods - ${buckets.method.length}`, 'method', buckets.method),
            new CategoryNode(useZh ? `纯取值 - ${buckets.value.length}` : `Value Access - ${buckets.value.length}`, 'value', buckets.value)
        ];
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
    constructor(public readonly label: string, public readonly location: vscode.Location) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = `L${this.location.range.start.line + 1}`;
        this.command = { command: 'vscode.open', title: "Jump", arguments: [this.location.uri, { selection: this.location.range }] };
    }
}