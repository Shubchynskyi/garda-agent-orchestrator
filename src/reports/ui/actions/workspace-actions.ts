import { buildUiActionDefinition } from './action-common';
import type { UiActionDefinition } from './types';

export function buildUiWorkspaceActionDefinitions(repoRoot: string): UiActionDefinition[] {
    return [
        buildUiActionDefinition(
            repoRoot,
            'garda-off',
            'Garda switch',
            'Turn Garda Off',
            'Move managed Garda root instruction files into inactive switch storage.',
            ['off', '--target-root', repoRoot],
            { mutates: true, confirmationPhrase: 'TURN GARDA OFF' }
        ),
        buildUiActionDefinition(
            repoRoot,
            'garda-on',
            'Garda switch',
            'Turn Garda On',
            'Restore managed Garda root instruction files from switch storage.',
            ['on', '--target-root', repoRoot],
            { mutates: true, confirmationPhrase: 'TURN GARDA ON' }
        )
    ];
}
