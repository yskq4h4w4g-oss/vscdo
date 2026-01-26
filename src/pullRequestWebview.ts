import * as vscode from 'vscode';
import { PullRequest, PipelineRun, AzureDevOpsClient, PullRequestChange, FileDiff } from './azureDevOpsClient';

export class PullRequestWebviewPanel {
    private static currentPanel: PullRequestWebviewPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private organizationUrl: string;
    private project: string;
    private repository: string;

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly client: AzureDevOpsClient,
        private pullRequest: PullRequest,
        organizationUrl: string,
        project: string,
        repository: string
    ) {
        this.organizationUrl = organizationUrl;
        this.project = project;
        this.repository = repository;
        this.panel = panel;

        // Set the webview's initial html content
        this.update();

        // Listen for when the panel is disposed
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        // Update the content based on view changes
        this.panel.onDidChangeViewState(
            () => {
                if (this.panel.visible) {
                    this.update();
                }
            },
            null,
            this.disposables
        );

        // Handle messages from the webview
        this.panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'copyLink':
                        await vscode.env.clipboard.writeText(message.url);
                        vscode.window.showInformationMessage('PR link copied to clipboard');
                        return;
                }
            },
            null,
            this.disposables
        );
    }

    public static createOrShow(
        extensionUri: vscode.Uri,
        client: AzureDevOpsClient,
        pullRequest: PullRequest,
        organizationUrl: string,
        project: string,
        repository: string
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it.
        if (PullRequestWebviewPanel.currentPanel) {
            PullRequestWebviewPanel.currentPanel.pullRequest = pullRequest;
            PullRequestWebviewPanel.currentPanel.update();
            PullRequestWebviewPanel.currentPanel.panel.reveal(column);
            return;
        }

        // Otherwise, create a new panel.
        const panel = vscode.window.createWebviewPanel(
            'azureDevOpsPR',
            `PR #${pullRequest.pullRequestId}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        PullRequestWebviewPanel.currentPanel = new PullRequestWebviewPanel(
            panel,
            client,
            pullRequest,
            organizationUrl,
            project,
            repository
        );
    }

    public dispose() {
        PullRequestWebviewPanel.currentPanel = undefined;

        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    private async update() {
        const webview = this.panel.webview;
        this.panel.title = `PR #${this.pullRequest.pullRequestId}`;

        try {
            // Fetch the latest pipelines and diffs
            const [pipelines, diffs] = await Promise.all([
                this.client.getPullRequestPipelines(this.pullRequest.pullRequestId),
                this.client.getPullRequestDiffs(this.pullRequest.pullRequestId)
            ]);
            webview.html = this.getHtmlForWebview(webview, this.pullRequest, pipelines, diffs);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            webview.html = this.getErrorHtml(errorMessage);
        }
    }

    private getErrorHtml(error: string): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Error</title>
        </head>
        <body>
            <h1>Error Loading Pull Request</h1>
            <p>${error}</p>
        </body>
        </html>`;
    }

    private getHtmlForWebview(webview: vscode.Webview, pr: PullRequest, pipelines: PipelineRun[], diffs: FileDiff[]): string {
        const sourceBranch = pr.sourceRefName.replace('refs/heads/', '');
        const targetBranch = pr.targetRefName.replace('refs/heads/', '');

        // Construct the web URL for the pull request
        const prWebUrl = `${this.organizationUrl}/${this.project}/_git/${this.repository}/pullrequest/${pr.pullRequestId}`;

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Pull Request #${pr.pullRequestId}</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                    padding: 20px;
                    line-height: 1.6;
                }
                h1, h2 {
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding-bottom: 10px;
                }
                .metadata {
                    display: grid;
                    grid-template-columns: 150px 1fr;
                    gap: 10px;
                    margin: 20px 0;
                    padding: 15px;
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    border-radius: 5px;
                }
                .metadata-label {
                    font-weight: bold;
                    color: var(--vscode-descriptionForeground);
                }
                .status-badge {
                    display: inline-block;
                    padding: 4px 12px;
                    border-radius: 12px;
                    font-size: 12px;
                    font-weight: bold;
                }
                .status-active {
                    background-color: var(--vscode-charts-green);
                    color: white;
                }
                .status-completed {
                    background-color: var(--vscode-charts-blue);
                    color: white;
                }
                .status-abandoned {
                    background-color: var(--vscode-charts-gray);
                    color: white;
                }
                .description {
                    margin: 20px 0;
                    padding: 15px;
                    background-color: var(--vscode-textBlockQuote-background);
                    border-left: 4px solid var(--vscode-textBlockQuote-border);
                    white-space: pre-wrap;
                }
                .latest-pipeline {
                    margin: 20px 0;
                    padding: 20px;
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    border-radius: 8px;
                    border: 2px solid var(--vscode-panel-border);
                }
                .latest-pipeline h2 {
                    margin-top: 0;
                    margin-bottom: 15px;
                    font-size: 18px;
                }
                .pipeline-item {
                    padding: 20px;
                    background-color: var(--vscode-editor-background);
                    border-radius: 6px;
                    border-left: 6px solid var(--vscode-panel-border);
                }
                .pipeline-item.succeeded {
                    border-left-color: var(--vscode-charts-green);
                }
                .pipeline-item.failed {
                    border-left-color: var(--vscode-charts-red);
                }
                .pipeline-item.inprogress {
                    border-left-color: var(--vscode-charts-yellow);
                }
                .pipeline-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 12px;
                }
                .pipeline-name {
                    font-weight: bold;
                    font-size: 18px;
                }
                .pipeline-status {
                    padding: 6px 12px;
                    border-radius: 6px;
                    font-size: 13px;
                    font-weight: bold;
                    text-transform: uppercase;
                }
                .pipeline-status.succeeded {
                    background-color: var(--vscode-charts-green);
                    color: white;
                }
                .pipeline-status.failed {
                    background-color: var(--vscode-charts-red);
                    color: white;
                }
                .pipeline-status.inprogress {
                    background-color: var(--vscode-charts-yellow);
                    color: black;
                }
                .pipeline-details {
                    font-size: 14px;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 12px;
                }
                .button {
                    display: inline-block;
                    margin-top: 10px;
                    padding: 8px 16px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    text-decoration: none;
                    border-radius: 4px;
                    font-size: 13px;
                }
                .button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                button.button {
                    border: none;
                    cursor: pointer;
                    font-family: var(--vscode-font-family);
                }
                .branches {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    font-family: monospace;
                    margin: 10px 0;
                }
                .branch {
                    padding: 4px 8px;
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    border-radius: 4px;
                }
                .changes {
                    margin-top: 30px;
                }
                .diff-file {
                    margin: 20px 0;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 6px;
                    overflow: hidden;
                }
                .diff-file-header {
                    padding: 12px 15px;
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .diff-file-header.add {
                    border-left: 4px solid var(--vscode-charts-green);
                }
                .diff-file-header.edit {
                    border-left: 4px solid var(--vscode-charts-blue);
                }
                .diff-file-header.delete {
                    border-left: 4px solid var(--vscode-charts-red);
                }
                .change-type {
                    padding: 4px 8px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: bold;
                    text-transform: uppercase;
                    min-width: 60px;
                    text-align: center;
                }
                .change-type.add {
                    background-color: var(--vscode-charts-green);
                    color: white;
                }
                .change-type.edit {
                    background-color: var(--vscode-charts-blue);
                    color: white;
                }
                .change-type.delete {
                    background-color: var(--vscode-charts-red);
                    color: white;
                }
                .change-type.rename {
                    background-color: var(--vscode-charts-yellow);
                    color: black;
                }
                .change-path {
                    font-family: monospace;
                    font-size: 13px;
                    flex: 1;
                    word-break: break-all;
                }
                .diff-content {
                    background-color: var(--vscode-editor-background);
                    overflow-x: auto;
                }
                .diff-block {
                    margin: 0;
                }
                .diff-row {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .diff-side {
                    display: flex;
                    min-height: 24px;
                }
                .diff-side.left {
                    border-right: 1px solid var(--vscode-panel-border);
                }
                .diff-line-number {
                    min-width: 50px;
                    padding: 2px 10px;
                    color: var(--vscode-descriptionForeground);
                    text-align: right;
                    user-select: none;
                    opacity: 0.6;
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    font-family: 'Consolas', 'Courier New', monospace;
                    font-size: 12px;
                    line-height: 1.5;
                }
                .diff-line-content {
                    flex: 1;
                    white-space: pre;
                    padding: 2px 10px;
                    overflow-x: auto;
                    font-family: 'Consolas', 'Courier New', monospace;
                    font-size: 12px;
                    line-height: 1.5;
                }
                .diff-side.deleted {
                    background-color: rgba(229, 83, 75, 0.15);
                }
                .diff-side.deleted .diff-line-number {
                    color: var(--vscode-charts-red);
                    opacity: 1;
                    background-color: rgba(229, 83, 75, 0.2);
                }
                .diff-side.added {
                    background-color: rgba(46, 160, 67, 0.15);
                }
                .diff-side.added .diff-line-number {
                    color: var(--vscode-charts-green);
                    opacity: 1;
                    background-color: rgba(46, 160, 67, 0.2);
                }
                .diff-side.unchanged {
                    background-color: transparent;
                }
                .diff-side.empty {
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                }
                .diff-expand {
                    padding: 8px;
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                    font-size: 12px;
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    border-top: 1px solid var(--vscode-panel-border);
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .no-changes {
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                    padding: 20px;
                    text-align: center;
                }
            </style>
        </head>
        <body>
            <h1>${this.escapeHtml(pr.title)}</h1>

            <div class="metadata">
                <span class="metadata-label">Status:</span>
                <span><span class="status-badge status-${pr.status.toLowerCase()}">${pr.status}</span></span>

                <span class="metadata-label">Pull Request ID:</span>
                <span>#${pr.pullRequestId}</span>

                <span class="metadata-label">Author:</span>
                <span>${this.escapeHtml(pr.createdBy.displayName)} (${this.escapeHtml(pr.createdBy.uniqueName)})</span>

                <span class="metadata-label">Created:</span>
                <span>${new Date(pr.creationDate).toLocaleString()}</span>

                <span class="metadata-label">Branches:</span>
                <div class="branches">
                    <span class="branch">${this.escapeHtml(sourceBranch)}</span>
                    <span>→</span>
                    <span class="branch">${this.escapeHtml(targetBranch)}</span>
                </div>
            </div>

            ${pipelines.length > 0 ? `
            <div class="latest-pipeline">
                <h2>Latest Pipeline</h2>
                ${this.getLatestPipelineHtml(pipelines[0])}
            </div>
            ` : ''}

            <a href="${prWebUrl}" class="button">Open in Azure DevOps</a>
            <button class="button" onclick="copyLink()">Copy Link</button>

            ${pr.description ? `
            <h2>Description</h2>
            <div class="description">${this.escapeHtml(pr.description)}</div>
            ` : ''}

            <div class="changes">
                <h2>File Changes (${diffs.length})</h2>
                ${diffs.length > 0 ? diffs.map(diff => this.getDiffHtml(diff)).join('') :
                '<div class="no-changes">No file changes found for this pull request</div>'}
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                function copyLink() {
                    vscode.postMessage({
                        command: 'copyLink',
                        url: '${prWebUrl}'
                    });
                }
            </script>
        </body>
        </html>`;
    }

    private getLatestPipelineHtml(pipeline: PipelineRun): string {
        const statusClass = pipeline.state.toLowerCase().replace(/\s+/g, '');
        const result = pipeline.result.toLowerCase();
        const state = pipeline.state.toLowerCase();

        let statusBadge = '';
        let statusBadgeClass = '';
        if (state === 'completed') {
            statusBadge = result;
            statusBadgeClass = result;
        } else {
            statusBadge = state;
            statusBadgeClass = state;
        }

        return `
        <div class="pipeline-item ${statusClass}">
            <div class="pipeline-header">
                <span class="pipeline-name">${this.escapeHtml(pipeline.name)}</span>
                <span class="pipeline-status ${statusBadgeClass}">${statusBadge}</span>
            </div>
            <div class="pipeline-details">
                Started: ${new Date(pipeline.createdDate).toLocaleString()}
                ${pipeline.finishedDate ? `<br>Finished: ${new Date(pipeline.finishedDate).toLocaleString()}` : ''}
            </div>
            <a href="${pipeline.url}" class="button">View Pipeline</a>
        </div>`;
    }

    private getPipelineHtml(pipeline: PipelineRun): string {
        const statusClass = pipeline.state.toLowerCase().replace(/\s+/g, '');
        const result = pipeline.result.toLowerCase();
        const state = pipeline.state.toLowerCase();

        let statusBadge = '';
        if (state === 'completed') {
            statusBadge = result;
        } else {
            statusBadge = state;
        }

        return `
        <div class="pipeline-item ${statusClass}">
            <div class="pipeline-header">
                <span class="pipeline-name">${this.escapeHtml(pipeline.name)}</span>
                <span class="pipeline-status">${statusBadge}</span>
            </div>
            <div class="pipeline-details">
                Started: ${new Date(pipeline.createdDate).toLocaleString()}
                ${pipeline.finishedDate ? `<br>Finished: ${new Date(pipeline.finishedDate).toLocaleString()}` : ''}
            </div>
            <a href="${pipeline.url}" class="button">View Pipeline</a>
        </div>`;
    }

    private getDiffHtml(diff: FileDiff): string {
        const changeType = diff.changeType.toLowerCase();
        let changeTypeClass = changeType;
        let changeTypeLabel = changeType;

        // Map Azure DevOps change types to our display types
        if (changeType === 'add') {
            changeTypeClass = 'add';
            changeTypeLabel = 'add';
        } else if (changeType === 'edit') {
            changeTypeClass = 'edit';
            changeTypeLabel = 'edit';
        } else if (changeType === 'delete') {
            changeTypeClass = 'delete';
            changeTypeLabel = 'delete';
        } else if (changeType === 'rename') {
            changeTypeClass = 'rename';
            changeTypeLabel = 'rename';
        }

        // Generate diff blocks HTML in side-by-side view
        let diffBlocksHtml = '';
        if (diff.blocks && diff.blocks.length > 0) {
            diffBlocksHtml = diff.blocks.map(block => {
                // Group lines for side-by-side display
                const rows = this.generateSideBySideRows(block.lines);

                const rowsHtml = rows.map(row => {
                    return `<div class="diff-row">
                        <div class="diff-side left ${row.leftType}">
                            <span class="diff-line-number">${row.leftNumber || ''}</span>
                            <span class="diff-line-content">${this.escapeHtml(row.leftContent || '')}</span>
                        </div>
                        <div class="diff-side right ${row.rightType}">
                            <span class="diff-line-number">${row.rightNumber || ''}</span>
                            <span class="diff-line-content">${this.escapeHtml(row.rightContent || '')}</span>
                        </div>
                    </div>`;
                }).join('');

                return `<div class="diff-block">${rowsHtml}</div>`;
            }).join('');
        } else {
            diffBlocksHtml = '<div class="diff-expand">No line changes available</div>';
        }

        return `
        <div class="diff-file">
            <div class="diff-file-header ${changeTypeClass}">
                <span class="change-type ${changeTypeClass}">${changeTypeLabel}</span>
                <span class="change-path">${this.escapeHtml(diff.path)}</span>
            </div>
            <div class="diff-content">
                ${diffBlocksHtml}
            </div>
        </div>`;
    }

    private generateSideBySideRows(lines: any[]): any[] {
        const rows: any[] = [];
        let leftLines: any[] = [];
        let rightLines: any[] = [];

        // Separate deleted and added lines
        for (const line of lines) {
            if (line.lineType === 'deleted') {
                leftLines.push(line);
            } else if (line.lineType === 'added') {
                rightLines.push(line);
            } else if (line.lineType === 'unchanged') {
                // Flush any pending changes first
                this.flushSideBySideChanges(leftLines, rightLines, rows);
                leftLines = [];
                rightLines = [];

                // Add unchanged line to both sides
                rows.push({
                    leftNumber: line.oLine,
                    leftContent: line.line,
                    leftType: 'unchanged',
                    rightNumber: line.mLine,
                    rightContent: line.line,
                    rightType: 'unchanged'
                });
            }
        }

        // Flush any remaining changes
        this.flushSideBySideChanges(leftLines, rightLines, rows);

        return rows;
    }

    private flushSideBySideChanges(leftLines: any[], rightLines: any[], rows: any[]): void {
        const maxLines = Math.max(leftLines.length, rightLines.length);

        for (let i = 0; i < maxLines; i++) {
            const leftLine = i < leftLines.length ? leftLines[i] : null;
            const rightLine = i < rightLines.length ? rightLines[i] : null;

            rows.push({
                leftNumber: leftLine?.oLine || '',
                leftContent: leftLine?.line || '',
                leftType: leftLine ? 'deleted' : 'empty',
                rightNumber: rightLine?.mLine || '',
                rightContent: rightLine?.line || '',
                rightType: rightLine ? 'added' : 'empty'
            });
        }
    }

    private escapeHtml(text: string): string {
        const map: { [key: string]: string } = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, (m) => map[m]);
    }
}
