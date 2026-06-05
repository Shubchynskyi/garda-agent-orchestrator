import { formatStatusSnapshot, type StatusSnapshot as DetailedStatusSnapshot } from '../../validators/status';
import { bold, cyan, dim, green, padRight, red, yellow } from './cli-colors';
import { printCommandSummary } from './cli-help-output';
import type { PackageJsonLike, StatusSnapshot } from './cli-types';

export function printBanner(
    packageJson: PackageJsonLike,
    title: string,
    subtitle: string,
    options?: { versionOverride?: string | null }
): void {
    const width = 62;
    const top = `+${'-'.repeat(width - 2)}+`;
    const titleText = ' GARDA AGENT ORCHESTRATOR ';
    const effectiveVersion = options && options.versionOverride !== undefined
        ? options.versionOverride
        : packageJson.version;
    const versionText = effectiveVersion ? `v${effectiveVersion}` : '';
    const titleLine = versionText
        ? `|${padRight(titleText, width - versionText.length - 3)} ${versionText}|`
        : `|${padRight(titleText, width - 2)}|`;
    console.log(cyan(top));
    console.log(cyan(titleLine));
    console.log(cyan(top));
    if (title) console.log(bold(title));
    if (subtitle) console.log(dim(subtitle));
}

export function buildBannerText(
    packageJson: PackageJsonLike,
    title: string,
    subtitle: string,
    options?: { versionOverride?: string | null }
): string {
    const width = 62;
    const top = `+${'-'.repeat(width - 2)}+`;
    const titleText = ' GARDA AGENT ORCHESTRATOR ';
    const effectiveVersion = options && options.versionOverride !== undefined
        ? options.versionOverride
        : packageJson.version;
    const versionText = effectiveVersion ? `v${effectiveVersion}` : '';
    const titleLine = versionText
        ? `|${padRight(titleText, width - versionText.length - 3)} ${versionText}|`
        : `|${padRight(titleText, width - 2)}|`;
    const lines = [top, titleLine, top];
    if (title) lines.push(title);
    if (subtitle) lines.push(subtitle);
    return lines.join('\n');
}

export function getStageBadge(completed: boolean, options?: { warning?: boolean }): string {
    const warning = (options && options.warning) || false;
    const label = completed ? '[x]' : '[ ]';
    if (completed) return green(label);
    if (warning) return yellow(label);
    return dim(label);
}

export function getWorkspaceHeadline(snapshot: StatusSnapshot): string {
    if (snapshot.readyForTasks) return green('Workspace ready');
    if (snapshot.primaryInitializationComplete) return yellow('Agent setup required');
    if (snapshot.bundlePresent) return yellow('Primary setup required');
    return red('Not installed');
}

function getLineFormattingType(line: string): 'headline' | 'section' | 'badge' | 'kvpair' | 'other' {
    if (line === 'Workspace ready' || line === 'Agent setup required' || 
        line === 'Primary setup required' || line === 'Not installed' ||
        line.startsWith('Error')) {
        return 'headline';
    }
    if (line === 'Workspace Stages' || line === 'Toxin Metrics') {
        return 'section';
    }
    if (line.includes('[x]') || line.includes('[~]') || line.includes('[ ]')) {
        return 'badge';
    }
    // Dynamic kvpair detection: matches "Key: value" pattern (starts with word followed by colon)
    if (/^[A-Za-z][A-Za-z0-9]*:\s/.test(line)) {
        return 'kvpair';
    }
    return 'other';
}

export function applyStatusFormatting(text: string): string {
    const lines = text.split('\n');
    const formatted = lines.map((line, index) => {
        // First line: heading
        if (index === 0) {
            return line;
        }
        
        const lineType = getLineFormattingType(line);
        
        if (lineType === 'headline') {
            return bold(line);
        }
        if (lineType === 'section') {
            return bold(line);
        }
        if (lineType === 'badge') {
            let formatted = line;
            formatted = formatted.replace(/\[x\]/g, green('[x]'));
            formatted = formatted.replace(/\[~\]/g, yellow('[~]'));
            formatted = formatted.replace(/\[ \]/g, dim('[ ]'));
            return formatted;
        }
        if (lineType === 'kvpair') {
            const colonIndex = line.indexOf(':');
            if (colonIndex !== -1) {
                const label = line.substring(0, colonIndex);
                const value = line.substring(colonIndex + 1).trim();
                return `${yellow(label + ':')} ${green(value)}`;
            }
        }
        
        return line;
    });
    return formatted.join('\n');
}

export function printStatus(snapshot: DetailedStatusSnapshot, options?: { heading?: string }): void {
    const formatted = formatStatusSnapshot(snapshot, options);
    const withColors = applyStatusFormatting(formatted);
    console.log(withColors);
    console.log('');
    printCommandSummary();
}
