import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createWorkflowSettingRegistry,
    type WorkflowSettingManifestEntry,
    type WorkflowSettingUiControl,
    type WorkflowSettingValueByType,
    type WorkflowSettingValueType
} from '../../../src/core/workflow-setting-manifest';

function booleanSetting(
    overrides: Partial<WorkflowSettingManifestEntry<'boolean'>> = {}
): WorkflowSettingManifestEntry<'boolean'> {
    return {
        id: 'full-suite-enabled',
        key: 'full_suite_validation.enabled',
        owner: { kind: 'workflow', section: 'full-suite-validation' },
        value_type: 'boolean',
        exposure: 'operator-visible',
        default_value: true,
        validate: (value: unknown): value is boolean => typeof value === 'boolean',
        cli: { flag: '--full-suite' },
        ui: {
            group: 'full-suite',
            label: 'Full suite',
            description: 'Run the bounded mandatory full-suite command.',
            control: 'checkbox'
        },
        materialize: (value) => [{ path: 'full_suite_validation.enabled', value }],
        ...overrides
    };
}

function typedSetting<TValueType extends WorkflowSettingValueType>(
    valueType: TValueType,
    defaultValue: WorkflowSettingValueByType[TValueType],
    control: WorkflowSettingUiControl,
    validate: (value: unknown) => value is WorkflowSettingValueByType[TValueType]
): WorkflowSettingManifestEntry<TValueType> {
    const stableId = valueType.replaceAll('_', '-');
    return {
        id: `${stableId}-setting`,
        key: `value_types.${valueType}`,
        owner: { kind: 'workflow', section: 'value-types' },
        value_type: valueType,
        exposure: 'operator-visible',
        default_value: defaultValue,
        validate,
        cli: { flag: `--${stableId}-setting` },
        ui: {
            group: 'value-types',
            label: `${valueType} setting`,
            description: `Configure a ${valueType} workflow setting.`,
            control
        },
        materialize: (value) => [{ path: `value_types.${valueType}`, value }]
    };
}

test('workflow-setting registry binds typed defaults, metadata, validation, and materialization', () => {
    const registry = createWorkflowSettingRegistry([booleanSetting()]);
    const entry = registry.require('full-suite-enabled');

    assert.equal(entry.default_value, true);
    assert.equal(entry.owner.kind, 'workflow');
    assert.equal(entry.cli.flag, '--full-suite');
    assert.equal(entry.ui.control, 'checkbox');
    assert.equal(registry.validate(entry.id, false), false);
    assert.deepEqual(registry.materialize(entry.id, false, { target: 'live' }), [
        { path: 'full_suite_validation.enabled', value: false }
    ]);
    assert.ok(Object.isFrozen(registry));
    assert.ok(Object.isFrozen(registry.entries));
    assert.ok(Object.isFrozen(entry));
});

test('workflow-setting registry supports catalog references and per-lane ownership without catalog definitions', () => {
    const registry = createWorkflowSettingRegistry([
        booleanSetting({
            id: 'architecture-review-enabled',
            key: 'review_policy.architecture.enabled',
            owner: { kind: 'catalog-backed', catalog: 'review', entry_id: 'architecture' },
            cli: { flag: '--review-architecture-enabled' },
            materialize: (value) => [{ path: 'review_policy.architecture.enabled', value }]
        }),
        booleanSetting({
            id: 'security-delta-enabled',
            key: 'review_policy.security.delta_enabled',
            owner: { kind: 'review-lane', lane_id: 'security' },
            cli: { flag: '--security-delta-enabled' },
            materialize: (value) => [{ path: 'review_policy.security.delta_enabled', value }]
        })
    ]);

    assert.deepEqual(registry.require('architecture-review-enabled').owner, {
        kind: 'catalog-backed',
        catalog: 'review',
        entry_id: 'architecture'
    });
    assert.deepEqual(registry.require('security-delta-enabled').owner, {
        kind: 'review-lane',
        lane_id: 'security'
    });
});

test('workflow-setting registry binds every declared value type to a compatible UI control', () => {
    assert.doesNotThrow(() => createWorkflowSettingRegistry([
        typedSetting('boolean', true, 'checkbox', (value): value is boolean => typeof value === 'boolean'),
        typedSetting('integer', 1, 'number', (value): value is number => Number.isSafeInteger(value)),
        typedSetting('enum', 'balanced', 'select', (value): value is string => typeof value === 'string'),
        typedSetting(
            'enum_list',
            ['code'],
            'select',
            (value): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')
        ),
        typedSetting('string', 'value', 'text', (value): value is string => typeof value === 'string'),
        typedSetting(
            'string_list',
            ['value'],
            'text_list',
            (value): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')
        )
    ]));
    assert.throws(
        () => createWorkflowSettingRegistry([booleanSetting({
            ui: {
                group: 'full-suite',
                label: 'Full suite',
                description: 'Run the bounded mandatory full-suite command.',
                control: 'number'
            }
        })]),
        /ui\.control is incompatible with value_type/u
    );
});

test('workflow-setting registry rejects duplicate ids, keys, and CLI flags, including case drift', () => {
    assert.throws(
        () => createWorkflowSettingRegistry([
            booleanSetting(),
            booleanSetting({ id: 'FULL-SUITE-ENABLED', key: 'other.enabled', cli: { flag: '--other-enabled' } })
        ]),
        /stable lowercase kebab-case/u
    );
    assert.throws(
        () => createWorkflowSettingRegistry([
            booleanSetting(),
            booleanSetting({ id: 'other-setting', cli: { flag: '--other-enabled' } })
        ]),
        /duplicate or case-drifted key/u
    );
    assert.throws(
        () => createWorkflowSettingRegistry([
            booleanSetting(),
            booleanSetting({ id: 'other-setting', key: 'other.enabled' })
        ]),
        /duplicate or case-drifted CLI flag/u
    );
});

test('workflow-setting registry rejects invalid defaults and secret-bearing contracts', () => {
    assert.throws(
        () => createWorkflowSettingRegistry([booleanSetting({ default_value: 'yes' as unknown as boolean })]),
        /default_value must satisfy/u
    );
    assert.throws(
        () => createWorkflowSettingRegistry([booleanSetting({
            id: 'api-token',
            key: 'credentials.api_token',
            cli: { flag: '--api-token' }
        })]),
        /cannot register secret-bearing settings/u
    );
    assert.throws(
        () => createWorkflowSettingRegistry([booleanSetting({
            id: 'ssh-key-material',
            key: 'credentials.private_key',
            cli: { flag: '--ssh-key-material' }
        })]),
        /cannot register secret-bearing settings/u
    );
    assert.throws(
        () => createWorkflowSettingRegistry([booleanSetting({
            id: 'remote-access-enabled',
            key: 'remote_access.enabled',
            cli: { flag: '--api-key' }
        })]),
        /cannot register secret-bearing settings/u
    );
    for (const key of ['credentials.api_key', 'credentials.access_key', 'credentials.bearer']) {
        assert.throws(
            () => createWorkflowSettingRegistry([booleanSetting({
                id: 'remote-access-enabled',
                key,
                cli: { flag: '--remote-access-enabled' }
            })]),
            /cannot register secret-bearing settings/u
        );
    }
    assert.throws(
        () => createWorkflowSettingRegistry([{
            ...booleanSetting(),
            value_type: 'string',
            default_value: true,
            validate: (_value: unknown): _value is string => true
        } as unknown as WorkflowSettingManifestEntry]),
        /default_value must satisfy its declared value_type/u
    );
});

test('workflow-setting registry fails closed for invalid values and unsafe materialization hooks', () => {
    const invalidValueRegistry = createWorkflowSettingRegistry([booleanSetting()]);
    assert.throws(() => invalidValueRegistry.validate('full-suite-enabled', 'false'), /Invalid value/u);
    assert.throws(() => invalidValueRegistry.require('missing-setting'), /Unknown workflow setting/u);
    const permissiveValidatorRegistry = createWorkflowSettingRegistry([booleanSetting({
        validate: (_value: unknown): _value is boolean => true
    })]);
    assert.throws(() => permissiveValidatorRegistry.validate('full-suite-enabled', 'false'), /Invalid value/u);
    assert.throws(
        () => invalidValueRegistry.materialize(
            'full-suite-enabled',
            true,
            { target: 'preview' } as unknown as { target: 'live' | 'template' }
        ),
        /target must be 'live' or 'template'/u
    );

    const unsafeRegistry = createWorkflowSettingRegistry([booleanSetting({
        materialize: (value) => [{ path: 'credentials.secret', value }]
    })]);
    assert.throws(
        () => unsafeRegistry.materialize('full-suite-enabled', true, { target: 'template' }),
        /invalid or secret-bearing materialization path/u
    );
    const privateKeyPathRegistry = createWorkflowSettingRegistry([booleanSetting({
        materialize: (value) => [{ path: 'credentials.private_key', value }]
    })]);
    assert.throws(
        () => privateKeyPathRegistry.materialize('full-suite-enabled', true, { target: 'template' }),
        /invalid or secret-bearing materialization path/u
    );
});
