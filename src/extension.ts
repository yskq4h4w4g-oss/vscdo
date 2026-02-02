import * as vscode from 'vscode';
import { AzureDevOpsClient, AzureDevOpsConfig, PullRequest } from './azureDevOpsClient';
import { PullRequestProvider } from './pullRequestProvider';
import { PullRequestWebviewPanel } from './pullRequestWebview';

const PAT_SECRET_KEY = 'azureDevOps.pat';

let client: AzureDevOpsClient | undefined;
let pullRequestProvider: PullRequestProvider;
let currentConfig: AzureDevOpsConfig | undefined;
let secretStorage: vscode.SecretStorage;
let extensionContext: vscode.ExtensionContext;

interface GitRemoteInfo {
    organizationUrl: string;
    project: string;
    repository: string;
}

function parseAzureDevOpsUrl(remoteUrl: string): GitRemoteInfo | undefined {
    // HTTPS format: https://dev.azure.com/org/project/_git/repo
    // HTTPS alt format: https://org.visualstudio.com/project/_git/repo
    // SSH format: git@ssh.dev.azure.com:v3/org/project/repo

    let match: RegExpMatchArray | null;

    // Try HTTPS dev.azure.com format (with optional username@)
    match = remoteUrl.match(/https:\/\/(?:[^@]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)/);
    if (match) {
        return {
            organizationUrl: `https://dev.azure.com/${match[1]}`,
            project: match[2],
            repository: match[3].replace(/\.git$/, '')
        };
    }

    // Try HTTPS visualstudio.com format (with optional username@)
    match = remoteUrl.match(/https:\/\/(?:[^@]+@)?([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)/);
    if (match) {
        return {
            organizationUrl: `https://dev.azure.com/${match[1]}`,
            project: match[2],
            repository: match[3].replace(/\.git$/, '')
        };
    }

    // Try SSH format
    match = remoteUrl.match(/git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)/);
    if (match) {
        return {
            organizationUrl: `https://dev.azure.com/${match[1]}`,
            project: match[2],
            repository: match[3].replace(/\.git$/, '')
        };
    }

    return undefined;
}

/**
 * Waits for a repository to have remotes available (with timeout).
 */
async function waitForRemotes(repo: Repository, timeoutMs: number = 5000): Promise<Remote[]> {
    // If remotes are already available, return them
    if (repo.state.remotes.length > 0) {
        return repo.state.remotes;
    }

    console.log('Waiting for repository remotes to be loaded...');

    return new Promise<Remote[]>((resolve) => {
        const timeout = setTimeout(() => {
            disposable.dispose();
            resolve(repo.state.remotes); // Return whatever we have (might be empty)
        }, timeoutMs);

        const disposable = repo.state.onDidChange(() => {
            if (repo.state.remotes.length > 0) {
                clearTimeout(timeout);
                disposable.dispose();
                resolve(repo.state.remotes);
            }
        });

        // Check again immediately in case state changed between our check and setting up the listener
        if (repo.state.remotes.length > 0) {
            clearTimeout(timeout);
            disposable.dispose();
            resolve(repo.state.remotes);
        }
    });
}

async function detectAzureDevOpsFromWorkspace(waitForRepo: boolean = false): Promise<GitRemoteInfo | undefined> {
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExtension) {
        console.log('Git extension not found');
        return undefined;
    }

    const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    const api = git.getAPI(1);

    // If no repositories found and we should wait, wait for the Git extension to discover them
    if (api.repositories.length === 0 && waitForRepo) {
        console.log('No git repositories found yet, waiting for Git extension to discover repositories...');

        // Wait for a repository to be opened (with a timeout)
        const repo = await new Promise<Repository | undefined>((resolve) => {
            // Check if a repo appears within 10 seconds
            const timeout = setTimeout(() => {
                disposable.dispose();
                resolve(undefined);
            }, 10000);

            const disposable = api.onDidOpenRepository((repository: Repository) => {
                clearTimeout(timeout);
                disposable.dispose();
                resolve(repository);
            });

            // Also check again immediately in case one was added between our check and setting up the listener
            if (api.repositories.length > 0) {
                clearTimeout(timeout);
                disposable.dispose();
                resolve(api.repositories[0]);
            }
        });

        if (!repo) {
            console.log('No git repositories found in workspace after waiting');
            return undefined;
        }

        // Wait for remotes to be loaded
        const remotes = await waitForRemotes(repo);
        const originRemote = remotes.find(r => r.name === 'origin');
        const remote = originRemote || remotes[0];

        if (!remote) {
            console.log('No git remotes found');
            return undefined;
        }

        const remoteUrl = remote.fetchUrl || remote.pushUrl;
        if (!remoteUrl) {
            console.log('No remote URL found');
            return undefined;
        }

        console.log(`Detected git remote URL: ${remoteUrl}`);
        const info = parseAzureDevOpsUrl(remoteUrl);

        if (info) {
            console.log(`Detected Azure DevOps repo: ${info.organizationUrl}/${info.project}/${info.repository}`);
        }

        return info;
    }

    if (api.repositories.length === 0) {
        console.log('No git repositories found in workspace');
        return undefined;
    }

    const repo = api.repositories[0];

    // Wait for remotes to be loaded if we should wait
    const remotes = waitForRepo ? await waitForRemotes(repo) : repo.state.remotes;

    // Try 'origin' first, then any other remote
    const originRemote = remotes.find(r => r.name === 'origin');
    const remote = originRemote || remotes[0];

    if (!remote) {
        console.log('No git remotes found');
        return undefined;
    }

    const remoteUrl = remote.fetchUrl || remote.pushUrl;
    if (!remoteUrl) {
        console.log('No remote URL found');
        return undefined;
    }

    console.log(`Detected git remote URL: ${remoteUrl}`);
    const info = parseAzureDevOpsUrl(remoteUrl);

    if (info) {
        console.log(`Detected Azure DevOps repo: ${info.organizationUrl}/${info.project}/${info.repository}`);
    }

    return info;
}

// Minimal type definitions for vscode.git extension
interface GitExtension {
    getAPI(version: 1): GitAPI;
}

interface GitAPI {
    repositories: Repository[];
    onDidOpenRepository: vscode.Event<Repository>;
}

interface Repository {
    state: RepositoryState;
}

interface RepositoryState {
    remotes: Remote[];
    onDidChange: vscode.Event<void>;
}

interface Remote {
    name: string;
    fetchUrl?: string;
    pushUrl?: string;
}

function getPullRequestWebUrl(pullRequestId: number): string {
    if (!currentConfig) {
        throw new Error('Azure DevOps not configured');
    }
    return `${currentConfig.organizationUrl}/${currentConfig.project}/_git/${currentConfig.repository}/pullrequest/${pullRequestId}`;
}

export async function activate(context: vscode.ExtensionContext) {
    console.log('Azure DevOps extension is now active');

    // Store extension context for global access
    extensionContext = context;

    // Initialize secret storage
    secretStorage = context.secrets;

    // Ensure we have the PAT from global state if available (fallback for edge cases)
    await ensurePATAvailable();

    // Migrate PAT from old config-based storage to SecretStorage
    await migratePATToSecretStorage();

    // Initialize the pull request provider
    pullRequestProvider = new PullRequestProvider();
    vscode.window.registerTreeDataProvider('azureDevOpsPullRequests', pullRequestProvider);

    // Initialize client with current configuration (wait for Git extension to discover repos on startup)
    await initializeClient(true);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('azureDevOps.configure', configureConnection),
        vscode.commands.registerCommand('azureDevOps.refreshPullRequests', refreshPullRequests),
        vscode.commands.registerCommand('azureDevOps.createPullRequest', createPullRequest),
        vscode.commands.registerCommand('azureDevOps.viewPullRequest', viewPullRequest),
        vscode.commands.registerCommand('azureDevOps.openPullRequestInBrowser', openPullRequestInBrowser),
        vscode.commands.registerCommand('azureDevOps.clearCredentials', clearCredentials),
        vscode.commands.registerCommand('azureDevOps.approvePullRequest', approvePullRequest),
        vscode.commands.registerCommand('azureDevOps.rejectPullRequest', rejectPullRequest),
        vscode.commands.registerCommand('azureDevOps.completePullRequest', completePullRequest)
    );

    // Listen for workspace folder changes to re-detect repo
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            console.log('Workspace folders changed, re-initializing client');
            await initializeClient();
        })
    );

    // Listen for secret storage changes
    context.subscriptions.push(
        context.secrets.onDidChange(async (e) => {
            if (e.key === PAT_SECRET_KEY) {
                console.log('PAT changed in secret storage, re-initializing client');
                await initializeClient();
            }
        })
    );

    // Show welcome message if PAT not configured
    const pat = await secretStorage.get(PAT_SECRET_KEY);
    if (!pat) {
        vscode.window.showInformationMessage(
            'Azure DevOps extension activated. Configure your PAT to get started.',
            'Configure'
        ).then(selection => {
            if (selection === 'Configure') {
                vscode.commands.executeCommand('azureDevOps.configure');
            }
        });
    }
}

/**
 * Migrates PAT from the old workspace configuration storage to the new SecretStorage.
 * This ensures a smooth transition for users upgrading from older versions.
 */
async function migratePATToSecretStorage(): Promise<void> {
    const config = vscode.workspace.getConfiguration('azureDevOps');
    const oldPat = config.get<string>('pat');

    if (oldPat) {
        // Check if we already have a PAT in secret storage
        const existingPat = await secretStorage.get(PAT_SECRET_KEY);

        if (!existingPat) {
            // Migrate the PAT to secret storage
            await secretStorage.store(PAT_SECRET_KEY, oldPat);
            console.log('Migrated PAT from workspace configuration to SecretStorage');
        }

        // Clear the old PAT from workspace configuration for security
        await config.update('pat', undefined, vscode.ConfigurationTarget.Global);
        await config.update('pat', undefined, vscode.ConfigurationTarget.Workspace);
        console.log('Cleared PAT from workspace configuration');

        vscode.window.showInformationMessage(
            'Your PAT has been migrated to secure storage.'
        );
    }
}

/**
 * Ensures the PAT is available by checking both SecretStorage and globalState.
 * Uses globalState as a backup mechanism for cross-window persistence.
 */
async function ensurePATAvailable(): Promise<void> {
    const GLOBAL_PAT_KEY = 'azureDevOps.pat.backup';

    // Try to get PAT from SecretStorage
    let pat = await secretStorage.get(PAT_SECRET_KEY);

    if (pat) {
        // PAT exists in SecretStorage, also save to globalState as backup
        await extensionContext.globalState.update(GLOBAL_PAT_KEY, pat);
        console.log('PAT found in SecretStorage, synced to globalState backup');
    } else {
        // No PAT in SecretStorage, try to restore from globalState backup
        const backupPat = extensionContext.globalState.get<string>(GLOBAL_PAT_KEY);

        if (backupPat) {
            // Restore PAT from globalState backup to SecretStorage
            await secretStorage.store(PAT_SECRET_KEY, backupPat);
            console.log('PAT restored from globalState backup to SecretStorage');
        }
    }
}

async function initializeClient(waitForRepo: boolean = false) {
    const pat = await secretStorage.get(PAT_SECRET_KEY);

    if (!pat) {
        client = undefined;
        currentConfig = undefined;
        pullRequestProvider.setClient(undefined);
        console.log('Azure DevOps PAT not configured');
        return;
    }

    // Try to detect repo info from workspace git remote
    const detectedInfo = await detectAzureDevOpsFromWorkspace(waitForRepo);

    if (!detectedInfo) {
        client = undefined;
        currentConfig = undefined;
        pullRequestProvider.setClient(undefined);
        console.log('Could not detect Azure DevOps repository from workspace');
        return;
    }

    const azureConfig: AzureDevOpsConfig = {
        organizationUrl: detectedInfo.organizationUrl,
        project: detectedInfo.project,
        repository: detectedInfo.repository,
        pat
    };

    try {
        client = new AzureDevOpsClient(azureConfig);
        currentConfig = azureConfig;
        pullRequestProvider.setClient(client);
        console.log(`Azure DevOps client initialized for ${detectedInfo.project}/${detectedInfo.repository}`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to initialize Azure DevOps client: ${errorMessage}`);
        client = undefined;
        currentConfig = undefined;
        pullRequestProvider.setClient(undefined);
    }
}

async function configureConnection() {
    // Show detected repo info if available
    const detectedInfo = await detectAzureDevOpsFromWorkspace();
    if (detectedInfo) {
        vscode.window.showInformationMessage(
            `Detected: ${detectedInfo.project}/${detectedInfo.repository}`
        );
    } else {
        vscode.window.showWarningMessage(
            'No Azure DevOps repository detected. Open a folder with an Azure DevOps git remote.'
        );
    }

    // Get PAT - don't show the existing PAT for security reasons
    const pat = await vscode.window.showInputBox({
        prompt: 'Enter your Personal Access Token (PAT)',
        password: true,
        placeHolder: 'Your PAT with Code (Read & Write) and Build (Read) permissions',
        ignoreFocusOut: true
    });

    if (!pat) {
        return;
    }

    // Save PAT to secure storage
    await secretStorage.store(PAT_SECRET_KEY, pat);

    // Also save to globalState as a backup for cross-window persistence
    await extensionContext.globalState.update('azureDevOps.pat.backup', pat);

    vscode.window.showInformationMessage('Azure DevOps PAT saved securely');

    // Reinitialize client
    await initializeClient();
}

/**
 * Clears the stored PAT from secure storage.
 */
async function clearCredentials() {
    const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to clear your stored PAT?',
        { modal: true },
        'Yes, Clear'
    );

    if (confirm === 'Yes, Clear') {
        await secretStorage.delete(PAT_SECRET_KEY);
        // Also clear the globalState backup
        await extensionContext.globalState.update('azureDevOps.pat.backup', undefined);
        client = undefined;
        currentConfig = undefined;
        pullRequestProvider.setClient(undefined);
        vscode.window.showInformationMessage('Azure DevOps credentials cleared');
    }
}

async function refreshPullRequests() {
    if (!client) {
        vscode.window.showWarningMessage('Azure DevOps not configured. Please configure first.');
        return;
    }

    pullRequestProvider.refresh();
    vscode.window.showInformationMessage('Pull requests refreshed');
}

async function createPullRequest() {
    if (!client) {
        vscode.window.showWarningMessage('Azure DevOps not configured. Please configure first.');
        return;
    }

    try {
        // Get branches
        const branches = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Fetching branches...',
                cancellable: false
            },
            async () => {
                return await client!.getBranches();
            }
        );

        // Select source branch
        const sourceBranch = await vscode.window.showQuickPick(
            branches.map(b => b.replace('refs/heads/', '')),
            {
                placeHolder: 'Select source branch'
            }
        );

        if (!sourceBranch) {
            return;
        }

        // Select target branch
        const targetBranch = await vscode.window.showQuickPick(
            branches.filter(b => b !== `refs/heads/${sourceBranch}`).map(b => b.replace('refs/heads/', '')),
            {
                placeHolder: 'Select target branch'
            }
        );

        if (!targetBranch) {
            return;
        }

        // Get title
        const title = await vscode.window.showInputBox({
            prompt: 'Enter pull request title',
            placeHolder: 'Add new feature'
        });

        if (!title) {
            return;
        }

        // Get description
        const description = await vscode.window.showInputBox({
            prompt: 'Enter pull request description (optional)',
            placeHolder: 'Describe your changes...'
        });

        // Create PR
        const pr = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Creating pull request...',
                cancellable: false
            },
            async () => {
                return await client!.createPullRequest({
                    sourceRefName: `refs/heads/${sourceBranch}`,
                    targetRefName: `refs/heads/${targetBranch}`,
                    title,
                    description: description || ''
                });
            }
        );

        vscode.window.showInformationMessage(`Pull request #${pr.pullRequestId} created successfully`);
        pullRequestProvider.refresh();

        // Ask if user wants to open PR
        const webUrl = getPullRequestWebUrl(pr.pullRequestId);
        const action = await vscode.window.showInformationMessage(
            'Pull request created',
            'View Details',
            'Open in Browser',
            'Copy Link'
        );

        if (action === 'View Details') {
            viewPullRequest(pr);
        } else if (action === 'Open in Browser') {
            vscode.env.openExternal(vscode.Uri.parse(webUrl));
        } else if (action === 'Copy Link') {
            await vscode.env.clipboard.writeText(webUrl);
            vscode.window.showInformationMessage('PR link copied to clipboard');
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to create pull request: ${errorMessage}`);
    }
}

function viewPullRequest(pullRequest: PullRequest) {
    if (!client || !currentConfig) {
        vscode.window.showWarningMessage('Azure DevOps not configured');
        return;
    }

    PullRequestWebviewPanel.createOrShow(
        vscode.Uri.file(__dirname),
        client,
        pullRequest,
        currentConfig.organizationUrl,
        currentConfig.project,
        currentConfig.repository
    );
}

function openPullRequestInBrowser(pullRequest: PullRequest) {
    const webUrl = getPullRequestWebUrl(pullRequest.pullRequestId);
    vscode.env.openExternal(vscode.Uri.parse(webUrl));
}

async function approvePullRequest(pullRequest: PullRequest) {
    if (!client) {
        vscode.window.showWarningMessage('Azure DevOps not configured');
        return;
    }

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Approving pull request...',
                cancellable: false
            },
            async () => {
                await client!.votePullRequest(pullRequest.pullRequestId, 10);
            }
        );

        vscode.window.showInformationMessage(`Pull request #${pullRequest.pullRequestId} approved`);
        pullRequestProvider.refresh();
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to approve pull request: ${errorMessage}`);
    }
}

async function rejectPullRequest(pullRequest: PullRequest) {
    if (!client) {
        vscode.window.showWarningMessage('Azure DevOps not configured');
        return;
    }

    // Ask for confirmation before rejecting
    const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to reject PR #${pullRequest.pullRequestId}?`,
        { modal: true },
        'Yes, Reject'
    );

    if (confirm !== 'Yes, Reject') {
        return;
    }

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Rejecting pull request...',
                cancellable: false
            },
            async () => {
                await client!.votePullRequest(pullRequest.pullRequestId, -10);
            }
        );

        vscode.window.showInformationMessage(`Pull request #${pullRequest.pullRequestId} rejected`);
        pullRequestProvider.refresh();
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to reject pull request: ${errorMessage}`);
    }
}

async function completePullRequest(pullRequest: PullRequest) {
    if (!client) {
        vscode.window.showWarningMessage('Azure DevOps not configured');
        return;
    }

    // Get saved preferences
    const config = vscode.workspace.getConfiguration('azureDevOps');
    const savedMergeStrategy = config.get<string>('defaultMergeStrategy', 'noFastForward');
    const savedDeleteSourceBranch = config.get<boolean>('defaultDeleteSourceBranch', false);

    // Build merge strategy options with saved preference first
    const mergeStrategyOptions = [
        { label: 'Merge (no fast-forward)', value: 'noFastForward', description: 'Create a merge commit' },
        { label: 'Squash', value: 'squash', description: 'Squash all commits into a single commit' },
        { label: 'Rebase', value: 'rebase', description: 'Rebase and fast-forward' },
        { label: 'Rebase and merge', value: 'rebaseMerge', description: 'Rebase and create a merge commit' }
    ];

    // Find and mark the saved option as default
    const savedIndex = mergeStrategyOptions.findIndex(opt => opt.value === savedMergeStrategy);
    if (savedIndex > 0) {
        // Move saved option to the top
        const [savedOption] = mergeStrategyOptions.splice(savedIndex, 1);
        savedOption.description += ' (saved default)';
        mergeStrategyOptions.unshift(savedOption);
    } else if (savedIndex === 0) {
        mergeStrategyOptions[0].description += ' (saved default)';
    }

    // Ask for merge strategy
    const mergeStrategy = await vscode.window.showQuickPick(
        mergeStrategyOptions,
        {
            placeHolder: 'Select merge strategy',
            title: `Complete PR #${pullRequest.pullRequestId}`
        }
    );

    if (!mergeStrategy) {
        return;
    }

    // Build delete source branch options with saved preference first
    const deleteOptions = savedDeleteSourceBranch
        ? [
            { label: 'Yes', value: true, description: 'Delete the source branch after merging (saved default)' },
            { label: 'No', value: false, description: 'Keep the source branch' }
        ]
        : [
            { label: 'No', value: false, description: 'Keep the source branch (saved default)' },
            { label: 'Yes', value: true, description: 'Delete the source branch after merging' }
        ];

    // Ask about deleting source branch
    const deleteSourceBranch = await vscode.window.showQuickPick(
        deleteOptions,
        {
            placeHolder: 'Delete source branch after merging?'
        }
    );

    if (deleteSourceBranch === undefined) {
        return;
    }

    // Final confirmation
    const sourceBranch = pullRequest.sourceRefName.replace('refs/heads/', '');
    const targetBranch = pullRequest.targetRefName.replace('refs/heads/', '');
    const confirmMessage = `Complete PR #${pullRequest.pullRequestId}?\n\nMerge "${sourceBranch}" into "${targetBranch}" using ${mergeStrategy.label.toLowerCase()}${deleteSourceBranch.value ? ' and delete source branch' : ''}`;

    const confirm = await vscode.window.showWarningMessage(
        confirmMessage,
        { modal: true },
        'Yes, Complete'
    );

    if (confirm !== 'Yes, Complete') {
        return;
    }

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Completing pull request...',
                cancellable: false
            },
            async () => {
                await client!.completePullRequest(pullRequest.pullRequestId, {
                    mergeStrategy: mergeStrategy.value as 'noFastForward' | 'squash' | 'rebase' | 'rebaseMerge',
                    deleteSourceBranch: deleteSourceBranch.value,
                    mergeCommitMessage: `Merged PR ${pullRequest.pullRequestId}: ${pullRequest.title}`
                });
            }
        );

        // Save the selected options as new defaults
        await config.update('defaultMergeStrategy', mergeStrategy.value, vscode.ConfigurationTarget.Global);
        await config.update('defaultDeleteSourceBranch', deleteSourceBranch.value, vscode.ConfigurationTarget.Global);

        vscode.window.showInformationMessage(`Pull request #${pullRequest.pullRequestId} completed successfully`);
        pullRequestProvider.refresh();
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to complete pull request: ${errorMessage}`);
    }
}

export function deactivate() {
    console.log('Azure DevOps extension deactivated');
}
