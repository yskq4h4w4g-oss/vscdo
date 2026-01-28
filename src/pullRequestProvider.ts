import * as vscode from 'vscode';
import { AzureDevOpsClient, PullRequest, PipelineRun } from './azureDevOpsClient';

export class PullRequestProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private client: AzureDevOpsClient | undefined;

    constructor() {}

    setClient(client: AzureDevOpsClient | undefined) {
        this.client = client;
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!this.client) {
            return [new TreeItem('Not configured', '', vscode.TreeItemCollapsibleState.None, 'info')];
        }

        try {
            if (!element) {
                // Root level - show pull requests
                const pullRequests = await this.client.getPullRequests('active');

                if (pullRequests.length === 0) {
                    return [new TreeItem('No active pull requests', '', vscode.TreeItemCollapsibleState.None, 'info')];
                }

                return pullRequests.map(pr => new PullRequestTreeItem(pr, this.client!));
            } else if (element instanceof PullRequestTreeItem) {
                // Show pipeline runs for this PR
                const pipelines = await this.client.getPullRequestPipelines(element.pullRequest.pullRequestId);

                if (pipelines.length === 0) {
                    return [new TreeItem('No pipelines found', '', vscode.TreeItemCollapsibleState.None, 'info')];
                }

                return pipelines.map(pipeline => new PipelineTreeItem(pipeline));
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Azure DevOps error: ${errorMessage}`);
            return [new TreeItem(`Error: ${errorMessage}`, '', vscode.TreeItemCollapsibleState.None, 'error')];
        }

        return [];
    }
}

class TreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly description: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string
    ) {
        super(label, collapsibleState);
        this.description = description;
        this.contextValue = contextValue;
    }
}

class PullRequestTreeItem extends vscode.TreeItem {
    constructor(
        public readonly pullRequest: PullRequest,
        private client: AzureDevOpsClient
    ) {
        super(pullRequest.title, vscode.TreeItemCollapsibleState.Collapsed);

        this.description = this.createDescription();
        this.tooltip = this.createTooltip();
        this.contextValue = 'pullRequest';
        this.iconPath = this.getIcon();

        // Store PR ID for commands
        this.command = {
            command: 'azureDevOps.viewPullRequest',
            title: 'View Pull Request',
            arguments: [this.pullRequest]
        };
    }

    private createDescription(): string {
        const pr = this.pullRequest;
        const reviewerSummary = this.getReviewerSummary();
        return `#${pr.pullRequestId} - ${pr.createdBy.displayName}${reviewerSummary ? ` | ${reviewerSummary}` : ''}`;
    }

    private getReviewerSummary(): string {
        const reviewers = this.pullRequest.reviewers || [];
        if (reviewers.length === 0) {
            return '';
        }

        const approved = reviewers.filter(r => r.vote >= 10).length;
        const approvedWithSuggestions = reviewers.filter(r => r.vote >= 5 && r.vote < 10).length;
        const waiting = reviewers.filter(r => r.vote < 0 && r.vote > -10).length;
        const rejected = reviewers.filter(r => r.vote <= -10).length;

        const parts: string[] = [];
        if (approved > 0) {
            parts.push(`${approved} approved`);
        }
        if (approvedWithSuggestions > 0) {
            parts.push(`${approvedWithSuggestions} with suggestions`);
        }
        if (waiting > 0) {
            parts.push(`${waiting} waiting`);
        }
        if (rejected > 0) {
            parts.push(`${rejected} rejected`);
        }

        return parts.join(', ') || `${reviewers.length} reviewer${reviewers.length === 1 ? '' : 's'}`;
    }

    private createTooltip(): string {
        const pr = this.pullRequest;
        const lines = [
            `Pull Request #${pr.pullRequestId}`,
            `Title: ${pr.title}`,
            `Author: ${pr.createdBy.displayName}`,
            `Source: ${pr.sourceRefName.replace('refs/heads/', '')}`,
            `Target: ${pr.targetRefName.replace('refs/heads/', '')}`,
            `Status: ${pr.status}`,
            `Created: ${new Date(pr.creationDate).toLocaleString()}`
        ];

        // Add reviewer info to tooltip
        const reviewers = pr.reviewers || [];
        if (reviewers.length > 0) {
            lines.push('');
            lines.push('Reviewers:');
            for (const r of reviewers) {
                const voteLabel = this.getVoteLabel(r.vote);
                lines.push(`  ${r.displayName}: ${voteLabel}`);
            }
        }

        return lines.join('\n');
    }

    private getVoteLabel(vote: number): string {
        if (vote >= 10) {
            return 'Approved';
        } else if (vote >= 5) {
            return 'Approved with suggestions';
        } else if (vote === 0) {
            return 'No vote';
        } else if (vote > -10) {
            return 'Waiting for author';
        } else {
            return 'Rejected';
        }
    }

    private getIcon(): vscode.ThemeIcon {
        switch (this.pullRequest.status.toLowerCase()) {
            case 'active':
                return new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor('charts.green'));
            case 'completed':
                return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.blue'));
            case 'abandoned':
                return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.gray'));
            default:
                return new vscode.ThemeIcon('git-pull-request');
        }
    }
}

class PipelineTreeItem extends vscode.TreeItem {
    constructor(public readonly pipeline: PipelineRun) {
        super(pipeline.name, vscode.TreeItemCollapsibleState.None);

        this.description = this.getStatusDescription();
        this.tooltip = this.createTooltip();
        this.contextValue = 'pipeline';
        this.iconPath = this.getIcon();

        // Open pipeline in browser when clicked
        this.command = {
            command: 'vscode.open',
            title: 'Open Pipeline',
            arguments: [vscode.Uri.parse(pipeline.url)]
        };
    }

    private getStatusDescription(): string {
        const state = this.pipeline.state;
        const result = this.pipeline.result;

        if (state === 'completed' && result) {
            return result.toLowerCase();
        }
        return state.toLowerCase();
    }

    private createTooltip(): string {
        const p = this.pipeline;
        const lines = [
            `Pipeline: ${p.name}`,
            `State: ${p.state}`,
            `Result: ${p.result}`,
            `Started: ${new Date(p.createdDate).toLocaleString()}`
        ];

        if (p.finishedDate) {
            lines.push(`Finished: ${new Date(p.finishedDate).toLocaleString()}`);
        }

        return lines.join('\n');
    }

    private getIcon(): vscode.ThemeIcon {
        const result = this.pipeline.result?.toLowerCase() ?? '';
        const state = this.pipeline.state.toLowerCase();

        if (state === 'inprogress' || state === 'notstarted') {
            return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
        }

        switch (result) {
            case 'succeeded':
                return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
            case 'failed':
                return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
            case 'partiallysucceeded':
                return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
            case 'canceled':
            case 'cancelled':
                return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.gray'));
            default:
                return new vscode.ThemeIcon('circle-outline');
        }
    }
}
