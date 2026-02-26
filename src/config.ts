import * as vscode from 'vscode';

export class ConfigManager {
    // 1. 定义静态变量，全局直接访问 ConfigManager.mutatingPrefixes 即可
    public static mutatingPrefixes: string[] = [];
    private static identifier: string = 'ref-read-write-detector';
    private static subIdentifier: string = 'customMutatingPrefixes';

    // 默认值
    private static readonly defaultPrefixes = [
        'set', 'add', 'remove', 'insert', 'delete', 'update',
        'append', 'replace', 'clear', 'reset', 'sort', 'exchange'
    ];

    // 2. 初始化方法：读取配置并开启监听
    public static init() {
        this.reloadConfig();

        // 监听配置变化，一旦用户修改设置，自动更新静态变量
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(`${this.identifier}.${this.subIdentifier}`)) {
                this.reloadConfig();
            }
        });
    }

    // 3. 具体的加载逻辑
    private static reloadConfig() {
        const config = vscode.workspace.getConfiguration(this.identifier);
        const rawCustomPrefixes = config.get<string[]>(this.subIdentifier, []);

        const normalizedCustomPrefixes = rawCustomPrefixes
            .map(prefix => prefix.trim().toLowerCase())
            .filter(prefix => prefix.length > 0);

        // 3. 合并默认值并去重
        // 注意：假设你的 defaultPrefixes 已经是全小写的
        this.mutatingPrefixes = Array.from(new Set([
            ...this.defaultPrefixes,
            ...normalizedCustomPrefixes
        ]));
    }
}