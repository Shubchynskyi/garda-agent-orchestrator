import { promptSingleSelect, promptTextInput } from '../cli-helpers';
import { getAllProfileNames, getProfileEntry } from './profile-data';
import {
    assertValidProfileName,
    buildDefaultProfileEntry,
    buildPromptReadyProfileEntry,
    buildSuggestedProfileName,
    cloneProfileEntry,
    KNOWN_REVIEW_TYPES,
    normalizeReviewPromptValue,
    parseStrictDepth,
    TOKEN_ECONOMY_FIELDS
} from './profile-model';
import { ParsedOptionsRecord, ProfileEntry, ProfilesData } from './profile-types';

async function promptBooleanChoice(title: string, currentValue: boolean, trueLabel = 'Yes', falseLabel = 'No'): Promise<boolean> {
    const selected = await promptSingleSelect({
        title,
        defaultLabel: currentValue ? trueLabel : falseLabel,
        options: [
            { label: trueLabel, value: 'true' },
            { label: falseLabel, value: 'false' }
        ],
        defaultValue: currentValue ? 'true' : 'false'
    });
    return selected === 'true';
}

async function promptReviewPolicyChoice(reviewType: string, currentValue: boolean | 'auto'): Promise<boolean | 'auto'> {
    const selected = await promptSingleSelect({
        title: `Review policy: ${reviewType} (from base)`,
        defaultLabel: String(currentValue),
        options: [
            { label: 'Auto', value: 'auto' },
            { label: 'Enabled', value: 'true' },
            { label: 'Disabled', value: 'false' }
        ],
        defaultValue: currentValue === 'auto' ? 'auto' : String(currentValue)
    });
    if (selected === 'auto') {
        return 'auto';
    }
    return selected === 'true';
}

async function promptForProfileName(data: ProfilesData): Promise<string> {
    let defaultName = buildSuggestedProfileName(data);
    for (;;) {
        const candidate = await promptTextInput('Enter profile name', defaultName);
        try {
            assertValidProfileName(candidate);
        } catch (error: unknown) {
            console.log(error instanceof Error ? error.message : String(error));
            defaultName = candidate || defaultName;
            continue;
        }
        if (getProfileEntry(data, candidate)) {
            console.log(`Profile '${candidate}' already exists. Choose a different name.`);
            defaultName = buildSuggestedProfileName(data);
            continue;
        }
        return candidate;
    }
}

async function promptForCopyFrom(data: ProfilesData): Promise<string> {
    return promptSingleSelect({
        title: 'Choose base profile for new profile settings',
        defaultLabel: 'Use default template',
        options: [
            { label: 'Use default template', value: '' },
            ...getAllProfileNames(data).map((name) => ({
                label: `Copy from ${name}`,
                value: name
            }))
        ],
        defaultValue: ''
    });
}

async function promptForDepth(defaultDepth: number, inheritSource: string): Promise<number> {
    const selected = await promptSingleSelect({
        title: `Select profile depth (from ${inheritSource})`,
        defaultLabel: `Depth ${defaultDepth}`,
        options: [
            { label: '1 - shallow', value: '1' },
            { label: '2 - balanced', value: '2' },
            { label: '3 - strict', value: '3' }
        ],
        defaultValue: String(defaultDepth)
    });
    return parseStrictDepth(selected);
}

export async function resolveInteractiveCreateInput(
    data: ProfilesData,
    options: ParsedOptionsRecord
): Promise<{ name: string; entry: ProfileEntry }> {
    const name = await promptForProfileName(data);

    let copyFrom: string | null = null;
    if (typeof options.copyFrom === 'string' && options.copyFrom.trim()) {
        const sourceName = options.copyFrom.trim();
        if (!getProfileEntry(data, sourceName)) {
            throw new Error(`Source profile '${options.copyFrom}' not found for --copy-from.`);
        }
        copyFrom = sourceName;
    } else {
        const selected = await promptForCopyFrom(data);
        copyFrom = selected || null;
    }
    const inheritSource = copyFrom ? `profile '${copyFrom}'` : 'default template';
    console.log(`Defaults are copied from ${inheritSource}. You can keep inherited values or override them.`);

    const sourceEntry = copyFrom
        ? buildPromptReadyProfileEntry(cloneProfileEntry(getProfileEntry(data, copyFrom)!))
        : buildDefaultProfileEntry(`User profile: ${name}`, 2);

    let description = typeof options.description === 'string'
        ? options.description.trim()
        : await promptTextInput(
            `Enter profile description (defaults from ${inheritSource})`,
            copyFrom ? `Copy of ${copyFrom}` : `User profile: ${name}`
        );
    description = description.trim();
    if (!description) {
        throw new Error('--description must not be empty.');
    }

    const depth = typeof options.depth === 'string'
        ? parseStrictDepth(options.depth)
        : await promptForDepth(sourceEntry.depth, inheritSource);

    const entry = buildPromptReadyProfileEntry({
        ...sourceEntry,
        description,
        depth
    });

    const customizeReviewPolicy = await promptBooleanChoice('Customize review policy', true, 'Customize', 'Keep base values');
    if (customizeReviewPolicy) {
        for (const reviewType of KNOWN_REVIEW_TYPES) {
            entry.review_policy[reviewType] = await promptReviewPolicyChoice(
                reviewType,
                normalizeReviewPromptValue(entry.review_policy[reviewType])
            );
        }
    }

    const customizeTokenEconomy = await promptBooleanChoice('Customize token economy', true, 'Customize', 'Keep base values');
    if (customizeTokenEconomy) {
        for (const field of TOKEN_ECONOMY_FIELDS) {
            entry.token_economy[field] = await promptBooleanChoice(
                `Token economy: ${field} (from base)`,
                entry.token_economy[field] !== false,
                'Enabled',
                'Disabled'
            );
        }
    }

    const customizeSkills = await promptBooleanChoice('Customize skill behavior', true, 'Customize', 'Keep base values');
    if (customizeSkills) {
        entry.skills.auto_suggest = await promptBooleanChoice(
            'Skills: auto_suggest',
            entry.skills.auto_suggest !== false,
            'Enabled',
            'Disabled'
        );
    }

    return { name, entry };
}
