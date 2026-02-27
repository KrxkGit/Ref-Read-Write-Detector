import * as vscode from 'vscode';

export class ConfigManager {
    // 1. 定义静态变量，全局直接访问 ConfigManager.mutatingPrefixes 即可
    public static mutatingPrefixes: string[] = [];
    public static mutatingPrompt: string = '';
    public static defaultExpandAllFileGroup: boolean = false;
    private static identifier: string = 'ref-read-write-detector';
    private static mutatingPrefixesIdentifier: string = 'customMutatingPrefixes';
    private static mutatingPromptIdentifier: string = 'customMutatingPrompt';
    private static defaultExpandAllFileGroupIdentifier: string = 'defaultExpandAllFileGroup';

    // 2. 初始化方法：读取配置并开启监听
    public static init() {
        this.reloadConfig();

        // 监听配置变化，一旦用户修改设置，自动更新静态变量
        vscode.workspace.onDidChangeConfiguration((e) => {
            let needChange = false;

            if (e.affectsConfiguration(`${this.identifier}.${this.mutatingPrefixesIdentifier}`)) {
                needChange = true;
            } else if (e.affectsConfiguration(`${this.identifier}.${this.mutatingPromptIdentifier}`)) {
                needChange = true;
            } else if (e.affectsConfiguration(`${this.identifier}.${this.defaultExpandAllFileGroupIdentifier}`)) {
                needChange = true;
            }

            if (needChange) {
                this.reloadConfig();
            }
        });
    }

    // 3. 具体的加载逻辑
    private static reloadConfig() {
        const config = vscode.workspace.getConfiguration(this.identifier);

        // 自定义 MutatingPrefix
        const rawCustomPrefixes = config.get<string[]>(this.mutatingPrefixesIdentifier, []);
        const normalizedCustomPrefixes = rawCustomPrefixes
            .map(prefix => prefix.trim().toLowerCase())
            .filter(prefix => prefix.length > 0);

        this.mutatingPrefixes = Array.from(new Set([
            ...normalizedCustomPrefixes
        ]));

        // 自定义 Mutating 附加文本提示
        this.mutatingPrompt = config.get<string>(this.mutatingPromptIdentifier, '');

        // 默认展开所有文件分析结果
        this.defaultExpandAllFileGroup = config.get<boolean>(this.defaultExpandAllFileGroupIdentifier, false);
    }
}