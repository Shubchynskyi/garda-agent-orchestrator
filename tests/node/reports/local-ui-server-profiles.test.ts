import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startLocalUiServer } from '../../../src/reports/ui';
import {
    makeLocalUiTempRepo,
    writeLocalUiRepoFixture
} from './local-ui-test-helpers';

function extractActionToken(html: string): string {
    const match = html.match(/const actionToken = "([^"]+)";/u);
    assert.ok(match, 'expected inline action token');
    return match[1];
}

function profilesPath(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'profiles.json');
}

test('local UI profiles endpoint reads, edits, and protects profile definitions', async () => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        actionsEnabled: true
    });
    try {
        const dashboardHtml = await (await fetch(server.url)).text();
        const actionToken = extractActionToken(dashboardHtml);
        assert.match(dashboardHtml, /profile-new-task-decomposition/u);
        assert.match(dashboardHtml, /Guarded task decomposition/u);
        const actionHeaders = {
            'content-type': 'application/json',
            'origin': server.url.slice(0, -1),
            'x-garda-action-token': actionToken
        };
        const previewProfileAction = async (payload: Record<string, unknown>): Promise<string> => {
            const response = await fetch(`${server.url}api/profiles`, {
                method: 'POST',
                headers: actionHeaders,
                body: JSON.stringify({ ...payload, mode: 'preview' })
            });
            assert.equal(response.status, 200);
            const result = await response.json() as { status: string; preview_sha256: string };
            assert.equal(result.status, 'previewed');
            assert.match(result.preview_sha256, /^[a-f0-9]{64}$/u);
            return result.preview_sha256;
        };

        const listResponse = await fetch(`${server.url}api/profiles`);
        assert.equal(listResponse.status, 200);
        const list = await listResponse.json() as {
            enabled: boolean;
            status: string;
            active_profile: string;
            finding_policy_actions: string[];
            finding_policy_presets: Record<string, { policy_id: string }>;
            review_types: Array<{ id: string }>;
            profiles: Array<{
                name: string;
                source: string;
                protected: boolean;
                active: boolean;
                task_decomposition: {
                    enabled: boolean;
                    configured: boolean;
                    provenance: string;
                };
                review_policy: Record<string, boolean | 'auto'>;
                review_follow_up_policy: {
                    task_profile: { mode: string; fixed_profile: string | null };
                };
                review_follow_up_task_profile_assignment: {
                    parent_profile: string;
                    profile: string;
                    source: string;
                    configured_mode: string;
                    diagnostics: string[];
                };
                review_remediation_mode_policy: {
                    configured: boolean;
                    legacy_full_only: boolean;
                    policy_id: string;
                    delta_eligible_review_types: string[];
                };
            }>;
        };
        assert.equal(list.enabled, true);
        assert.equal(list.status, 'present');
        assert.equal(list.active_profile, 'balanced');
        assert.deepEqual(list.finding_policy_actions, ['fix_now', 'create_follow_up', 'ignore']);
        assert.equal(list.finding_policy_presets.strict.policy_id, 'strict');
        assert.ok(list.review_types.some((reviewType) => reviewType.id === 'test'));
        assert.ok(list.profiles.some((profile) => profile.name === 'balanced' && profile.protected));
        const balancedProfile = list.profiles.find((profile) => profile.name === 'balanced');
        assert.ok(balancedProfile);
        assert.equal(balancedProfile.task_decomposition.enabled, true);
        assert.equal(balancedProfile.review_remediation_mode_policy.configured, true);
        assert.equal(balancedProfile.review_remediation_mode_policy.legacy_full_only, false);
        assert.deepEqual(
            balancedProfile.review_remediation_mode_policy.delta_eligible_review_types,
            ['api', 'code', 'db', 'dependency', 'infra', 'performance', 'refactor', 'security', 'test']
        );
        assert.ok([
            'explicit_profile_config',
            'legacy_balanced_default'
        ].includes(balancedProfile.task_decomposition.provenance));
        assert.deepEqual(balancedProfile.review_follow_up_task_profile_assignment, {
            parent_profile: 'balanced',
            profile: 'fast',
            source: 'one_level_lighter',
            configured_mode: 'one_level_lighter',
            diagnostics: ["Follow-up task profile lowered from 'balanced' to 'fast'."]
        });

        const createPayload = {
            operation: 'create',
            profile_name: 'custom-review',
            copy_from: 'balanced',
            description: 'Custom profile',
            depth: '3',
            task_decomposition: { enabled: true },
            review_policy: {
                code: 'required',
                test: 'auto',
                performance: 'disabled',
                security: true
            },
            review_follow_up_policy: {
                schema_version: 1,
                materialization_mode: 'grouped_by_parent',
                task_profile: {
                    mode: 'fixed_profile',
                    fixed_profile: 'fast'
                }
            },
            review_remediation_mode_policy: {
                delta_eligible_review_types: ['code', 'test']
            }
        };
        const createPreviewResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                ...createPayload,
                mode: 'preview',
            })
        });
        assert.equal(createPreviewResponse.status, 200);
        const createPreview = await createPreviewResponse.json() as {
            status: string;
            confirmation_phrase: string;
            changed_keys: string[];
            command: string;
            preview_sha256: string;
        };
        assert.equal(createPreview.status, 'previewed');
        assert.equal(createPreview.confirmation_phrase, 'APPLY PROFILE CHANGE');
        assert.deepEqual(createPreview.changed_keys, ['user_profiles.custom-review']);
        assert.match(createPreview.command, /profile create custom-review/u);
        assert.match(createPreview.preview_sha256, /^[a-f0-9]{64}$/u);

        const invalidNameResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                operation: 'create',
                mode: 'preview',
                profile_name: 'bad profile name',
                copy_from: 'balanced'
            })
        });
        assert.equal(invalidNameResponse.status, 400);
        const invalidName = await invalidNameResponse.json() as { code: string; error: string };
        assert.equal(invalidName.code, 'invalid_profile_request');
        assert.match(invalidName.error, /Profile name/u);

        for (const previewSha256 of [undefined, 'not-a-sha256']) {
            const invalidPreviewResponse = await fetch(`${server.url}api/profiles`, {
                method: 'POST',
                headers: actionHeaders,
                body: JSON.stringify({
                    ...createPayload,
                    mode: 'execute',
                    confirmation: 'APPLY PROFILE CHANGE',
                    ...(previewSha256 === undefined ? {} : { preview_sha256: previewSha256 })
                })
            });
            assert.equal(invalidPreviewResponse.status, 400);
            const invalidPreview = await invalidPreviewResponse.json() as { code: string; error: string };
            assert.equal(invalidPreview.code, 'invalid_profile_request');
            assert.match(invalidPreview.error, /preview_sha256/u);
        }

        const mismatchedPreviewSha256 = `${createPreview.preview_sha256[0] === '0' ? '1' : '0'}${createPreview.preview_sha256.slice(1)}`;
        const mismatchedPreviewResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                ...createPayload,
                mode: 'execute',
                confirmation: 'APPLY PROFILE CHANGE',
                preview_sha256: mismatchedPreviewSha256
            })
        });
        assert.equal(mismatchedPreviewResponse.status, 409);
        const mismatchedPreview = await mismatchedPreviewResponse.json() as { code: string; status: string };
        assert.equal(mismatchedPreview.code, 'state_conflict');
        assert.equal(mismatchedPreview.status, 'state_conflict');
        assert.equal(Object.hasOwn(
            JSON.parse(fs.readFileSync(profilesPath(repoRoot), 'utf8')).user_profiles,
            'custom-review'
        ), false);

        const driftPayload = { operation: 'select', profile_name: 'fast' };
        const driftPreviewSha256 = await previewProfileAction(driftPayload);
        const beforeDriftText = fs.readFileSync(profilesPath(repoRoot), 'utf8');
        const driftedData = JSON.parse(beforeDriftText) as {
            built_in_profiles: Record<string, { description: string }>;
        };
        driftedData.built_in_profiles.balanced.description = 'Changed after preview';
        fs.writeFileSync(profilesPath(repoRoot), JSON.stringify(driftedData, null, 2), 'utf8');
        const driftResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                ...driftPayload,
                mode: 'execute',
                confirmation: 'APPLY PROFILE CHANGE',
                preview_sha256: driftPreviewSha256
            })
        });
        assert.equal(driftResponse.status, 409);
        const driftResult = await driftResponse.json() as { code: string; status: string };
        assert.equal(driftResult.code, 'state_conflict');
        assert.equal(driftResult.status, 'state_conflict');
        assert.equal(JSON.parse(fs.readFileSync(profilesPath(repoRoot), 'utf8')).active_profile, 'balanced');
        fs.writeFileSync(profilesPath(repoRoot), beforeDriftText, 'utf8');

        const createBlockedResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                ...createPayload,
                mode: 'execute',
                confirmation: 'wrong',
                preview_sha256: createPreview.preview_sha256
            })
        });
        assert.equal(createBlockedResponse.status, 409);
        assert.equal((await createBlockedResponse.json() as { status: string }).status, 'confirmation_required');

        const createResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                ...createPayload,
                mode: 'execute',
                confirmation: 'APPLY PROFILE CHANGE',
                preview_sha256: createPreview.preview_sha256
            })
        });
        assert.equal(createResponse.status, 200);
        const create = await createResponse.json() as { status: string; audit_path: string };
        assert.equal(create.status, 'executed');
        const createdData = JSON.parse(fs.readFileSync(profilesPath(repoRoot), 'utf8')) as {
            user_profiles: Record<string, {
                depth: number;
                task_decomposition: { enabled: boolean };
                review_policy: Record<string, unknown>;
                review_follow_up_policy: {
                    task_profile: { mode: string; fixed_profile: string | null };
                };
                review_remediation_mode_policy: {
                    schema_version: number;
                    delta_eligible_review_types: string[];
                    force_full_categories: string[];
                    max_delta_changed_files: number;
                    max_delta_changed_lines: number;
                    max_consecutive_delta_reviews: number;
                };
            }>;
        };
        assert.equal(createdData.user_profiles['custom-review'].depth, 3);
        assert.equal(createdData.user_profiles['custom-review'].task_decomposition.enabled, true);
        assert.equal(createdData.user_profiles['custom-review'].review_policy.code, true);
        assert.equal(createdData.user_profiles['custom-review'].review_policy.test, 'auto');
        assert.equal(createdData.user_profiles['custom-review'].review_policy.performance, false);
        assert.equal(createdData.user_profiles['custom-review'].review_policy.security, true);
        assert.equal(
            createdData.user_profiles['custom-review'].review_follow_up_policy.task_profile.mode,
            'fixed_profile'
        );
        assert.equal(
            createdData.user_profiles['custom-review'].review_follow_up_policy.task_profile.fixed_profile,
            'fast'
        );
        assert.equal(createdData.user_profiles['custom-review'].review_remediation_mode_policy.schema_version, 2);
        assert.deepEqual(
            createdData.user_profiles['custom-review'].review_remediation_mode_policy.delta_eligible_review_types,
            ['code', 'test']
        );
        assert.deepEqual(
            createdData.user_profiles['custom-review'].review_remediation_mode_policy.force_full_categories,
            ['ambiguous', 'generated_churn', 'global']
        );
        assert.deepEqual({
            files: createdData.user_profiles['custom-review'].review_remediation_mode_policy.max_delta_changed_files,
            lines: createdData.user_profiles['custom-review'].review_remediation_mode_policy.max_delta_changed_lines,
            consecutive: createdData.user_profiles['custom-review'].review_remediation_mode_policy.max_consecutive_delta_reviews
        }, { files: 4, lines: 240, consecutive: 3 });
        const updatedList = await (await fetch(`${server.url}api/profiles`)).json() as {
            profiles: Array<{
                name: string;
                review_follow_up_task_profile_assignment: {
                    profile: string;
                    source: string;
                };
            }>;
        };
        const customProfile = updatedList.profiles.find((profile) => profile.name === 'custom-review');
        assert.ok(customProfile);
        assert.equal(customProfile.review_follow_up_task_profile_assignment.profile, 'fast');
        assert.equal(customProfile.review_follow_up_task_profile_assignment.source, 'fixed_profile');
        assert.match(fs.readFileSync(create.audit_path, 'utf8'), /"action_id":"profile:create:custom-review"/u);

        const unsafePolicyResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                operation: 'policy',
                mode: 'preview',
                profile_name: 'custom-review',
                policy_preset: 'custom',
                policy_actions: {
                    critical: 'ignore',
                    high: 'fix_now',
                    medium: 'create_follow_up',
                    low: 'ignore',
                    residual_risk: 'create_follow_up'
                }
            })
        });
        assert.equal(unsafePolicyResponse.status, 400);
        assert.match(
            (await unsafePolicyResponse.json() as { error: string }).error,
            /critical is immutable and must be fix_now/iu
        );

        const presetPolicyPayload = {
            operation: 'policy',
            profile_name: 'custom-review',
            policy_preset: 'strict'
        };
        const presetPolicyPreviewSha256 = await previewProfileAction(presetPolicyPayload);
        const presetPolicyApplyResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                ...presetPolicyPayload,
                mode: 'execute',
                confirmation: 'APPLY PROFILE CHANGE',
                preview_sha256: presetPolicyPreviewSha256
            })
        });
        assert.equal(presetPolicyApplyResponse.status, 200);
        assert.equal(
            JSON.parse(fs.readFileSync(profilesPath(repoRoot), 'utf8')).user_profiles['custom-review'].review_finding_policy.policy_id,
            'strict'
        );

        const customPolicyPayload = {
            operation: 'policy',
            profile_name: 'custom-review',
            policy_preset: 'custom',
            policy_actions: {
                critical: 'fix_now',
                high: 'fix_now',
                medium: 'create_follow_up',
                low: 'ignore',
                residual_risk: 'create_follow_up'
            }
        };
        const customPolicyPreviewResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ ...customPolicyPayload, mode: 'preview' })
        });
        assert.equal(customPolicyPreviewResponse.status, 200);
        const customPolicyPreview = await customPolicyPreviewResponse.json() as {
            status: string;
            preview_sha256: string;
            changed_keys: string[];
            proposed_value: {
                policy: { policy_id: string; findings: { critical: string; low: string } };
                task_effect: { scope: string; active_task_snapshots_changed: boolean };
            };
        };
        assert.equal(customPolicyPreview.status, 'previewed');
        assert.deepEqual(customPolicyPreview.changed_keys, ['user_profiles.custom-review.review_finding_policy']);
        assert.equal(customPolicyPreview.proposed_value.policy.policy_id, 'custom');
        assert.equal(customPolicyPreview.proposed_value.policy.findings.critical, 'fix_now');
        assert.equal(customPolicyPreview.proposed_value.policy.findings.low, 'ignore');
        assert.deepEqual(customPolicyPreview.proposed_value.task_effect, {
            scope: 'future_tasks_only',
            active_task_snapshots_changed: false
        });
        const customPolicyApplyResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                ...customPolicyPayload,
                mode: 'execute',
                confirmation: 'APPLY PROFILE CHANGE',
                preview_sha256: customPolicyPreview.preview_sha256
            })
        });
        assert.equal(customPolicyApplyResponse.status, 200);
        assert.equal(
            JSON.parse(fs.readFileSync(profilesPath(repoRoot), 'utf8')).user_profiles['custom-review'].review_finding_policy.policy_id,
            'custom'
        );

        const copyPolicyPayload = {
            operation: 'policy',
            profile_name: 'custom-review',
            policy_copy_from: 'balanced'
        };
        const copyPolicyPreviewSha256 = await previewProfileAction(copyPolicyPayload);
        const copyPolicyApplyResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                ...copyPolicyPayload,
                mode: 'execute',
                confirmation: 'APPLY PROFILE CHANGE',
                preview_sha256: copyPolicyPreviewSha256
            })
        });
        assert.equal(copyPolicyApplyResponse.status, 200);
        assert.equal(
            JSON.parse(fs.readFileSync(profilesPath(repoRoot), 'utf8')).user_profiles['custom-review'].review_finding_policy.policy_id,
            'strict'
        );

        const resetPolicyPayload = {
            operation: 'policy',
            profile_name: 'custom-review',
            policy_reset: true
        };
        const resetPolicyPreviewSha256 = await previewProfileAction(resetPolicyPayload);
        const resetPolicyApplyResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                ...resetPolicyPayload,
                mode: 'execute',
                confirmation: 'APPLY PROFILE CHANGE',
                preview_sha256: resetPolicyPreviewSha256
            })
        });
        assert.equal(resetPolicyApplyResponse.status, 200);
        assert.equal(
            JSON.parse(fs.readFileSync(profilesPath(repoRoot), 'utf8')).user_profiles['custom-review'].review_finding_policy.policy_id,
            'strict'
        );

        const deleteBuiltInResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                operation: 'delete',
                mode: 'preview',
                profile_name: 'balanced'
            })
        });
        assert.equal(deleteBuiltInResponse.status, 400);
        assert.equal((await deleteBuiltInResponse.json() as { code: string }).code, 'invalid_profile_request');

        const selectPayload = { operation: 'select', profile_name: 'custom-review' };
        const selectPreviewSha256 = await previewProfileAction(selectPayload);
        const selectResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                ...selectPayload,
                mode: 'execute',
                confirmation: 'APPLY PROFILE CHANGE',
                preview_sha256: selectPreviewSha256
            })
        });
        assert.equal(selectResponse.status, 200);
        assert.equal((await selectResponse.json() as { status: string }).status, 'executed');
        assert.equal(JSON.parse(fs.readFileSync(profilesPath(repoRoot), 'utf8')).active_profile, 'custom-review');

        const deletePayload = { operation: 'delete', profile_name: 'custom-review' };
        const deletePreviewSha256 = await previewProfileAction(deletePayload);
        const deleteResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                ...deletePayload,
                mode: 'execute',
                confirmation: 'APPLY PROFILE CHANGE',
                preview_sha256: deletePreviewSha256
            })
        });
        assert.equal(deleteResponse.status, 200);
        const deletedData = JSON.parse(fs.readFileSync(profilesPath(repoRoot), 'utf8')) as {
            active_profile: string;
            user_profiles: Record<string, unknown>;
        };
        assert.equal(Object.hasOwn(deletedData.user_profiles, 'custom-review'), false);
        assert.equal(deletedData.active_profile, 'balanced');

        const saveBuiltInPayload = {
            operation: 'save',
            profile_name: 'balanced',
            description: 'Locally edited balanced',
            depth: '1',
            task_decomposition: { enabled: false },
            review_policy: { code: true, test: true },
            review_remediation_mode_policy: {
                delta_eligible_review_types: ['code', 'test']
            }
        };
        const beforeInvalidRemediationRequests = fs.readFileSync(profilesPath(repoRoot), 'utf8');
        for (const reviewRemediationModePolicy of [
            { delta_eligible_review_types: ['unknown-review'] },
            {
                delta_eligible_review_types: ['code'],
                force_full_categories: []
            }
        ]) {
            const invalidRemediationResponse = await fetch(`${server.url}api/profiles`, {
                method: 'POST',
                headers: actionHeaders,
                body: JSON.stringify({
                    ...saveBuiltInPayload,
                    mode: 'preview',
                    review_remediation_mode_policy: reviewRemediationModePolicy
                })
            });
            assert.equal(invalidRemediationResponse.status, 400);
            assert.equal(
                (await invalidRemediationResponse.json() as { code: string }).code,
                'invalid_profile_request'
            );
        }
        assert.equal(fs.readFileSync(profilesPath(repoRoot), 'utf8'), beforeInvalidRemediationRequests);
        const saveBuiltInPreviewSha256 = await previewProfileAction(saveBuiltInPayload);
        const saveBuiltInResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                ...saveBuiltInPayload,
                mode: 'execute',
                confirmation: 'APPLY PROFILE CHANGE',
                preview_sha256: saveBuiltInPreviewSha256
            })
        });
        assert.equal(saveBuiltInResponse.status, 200);
        const saveBuiltIn = await saveBuiltInResponse.json() as {
            proposed_value: {
                source: string;
            };
        };
        assert.equal(saveBuiltIn.proposed_value.source, 'built_in');
        assert.equal(JSON.parse(fs.readFileSync(profilesPath(repoRoot), 'utf8')).built_in_profiles.balanced.depth, 1);
        assert.equal(
            JSON.parse(fs.readFileSync(profilesPath(repoRoot), 'utf8')).built_in_profiles.balanced.task_decomposition.enabled,
            false
        );
        const savedBalancedPolicy = JSON.parse(
            fs.readFileSync(profilesPath(repoRoot), 'utf8')
        ).built_in_profiles.balanced.review_remediation_mode_policy;
        assert.deepEqual(savedBalancedPolicy.delta_eligible_review_types, ['code', 'test']);
        assert.deepEqual(savedBalancedPolicy.force_full_categories, ['ambiguous', 'generated_churn', 'global']);
        assert.deepEqual({
            files: savedBalancedPolicy.max_delta_changed_files,
            lines: savedBalancedPolicy.max_delta_changed_lines,
            consecutive: savedBalancedPolicy.max_consecutive_delta_reviews
        }, { files: 4, lines: 240, consecutive: 3 });

        const localizedCreatePayload = {
            operation: 'create',
            profile_name: 'ьестовый',
            copy_from: 'balanced',
            description: 'Localized profile'
        };
        const localizedCreatePreviewSha256 = await previewProfileAction(localizedCreatePayload);
        const localizedCreateResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                ...localizedCreatePayload,
                mode: 'execute',
                confirmation: 'APPLY PROFILE CHANGE',
                preview_sha256: localizedCreatePreviewSha256
            })
        });
        assert.equal(localizedCreateResponse.status, 200);
        const localizedData = JSON.parse(fs.readFileSync(profilesPath(repoRoot), 'utf8')) as {
            user_profiles: Record<string, unknown>;
        };
        assert.ok(Object.hasOwn(localizedData.user_profiles, 'ьестовый'));

        const resetPayload = { operation: 'reset', profile_name: 'balanced' };
        const resetPreviewSha256 = await previewProfileAction(resetPayload);
        const resetResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                ...resetPayload,
                mode: 'execute',
                confirmation: 'APPLY PROFILE CHANGE',
                preview_sha256: resetPreviewSha256
            })
        });
        assert.equal(resetResponse.status, 200);
        assert.equal(JSON.parse(fs.readFileSync(profilesPath(repoRoot), 'utf8')).built_in_profiles.balanced.depth, 2);
    } finally {
        await server.close();
    }
});
