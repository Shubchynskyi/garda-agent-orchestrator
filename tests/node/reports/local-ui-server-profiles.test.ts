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
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const actionHeaders = {
            'content-type': 'application/json',
            'origin': server.url.slice(0, -1),
            'x-garda-action-token': actionToken
        };

        const listResponse = await fetch(`${server.url}api/profiles`);
        assert.equal(listResponse.status, 200);
        const list = await listResponse.json() as {
            enabled: boolean;
            status: string;
            active_profile: string;
            review_types: Array<{ id: string }>;
            profiles: Array<{
                name: string;
                source: string;
                protected: boolean;
                active: boolean;
                review_policy: Record<string, boolean | 'auto'>;
            }>;
        };
        assert.equal(list.enabled, true);
        assert.equal(list.status, 'present');
        assert.equal(list.active_profile, 'balanced');
        assert.ok(list.review_types.some((reviewType) => reviewType.id === 'test'));
        assert.ok(list.profiles.some((profile) => profile.name === 'balanced' && profile.protected));

        const createPreviewResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                operation: 'create',
                mode: 'preview',
                profile_name: 'custom-review',
                copy_from: 'balanced',
                description: 'Custom profile',
                depth: '2'
            })
        });
        assert.equal(createPreviewResponse.status, 200);
        const createPreview = await createPreviewResponse.json() as {
            status: string;
            confirmation_phrase: string;
            changed_keys: string[];
            command: string;
        };
        assert.equal(createPreview.status, 'previewed');
        assert.equal(createPreview.confirmation_phrase, 'APPLY PROFILE CHANGE');
        assert.deepEqual(createPreview.changed_keys, ['user_profiles.custom-review']);
        assert.match(createPreview.command, /profile create custom-review/u);

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

        const createBlockedResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                operation: 'create',
                mode: 'execute',
                profile_name: 'custom-review',
                copy_from: 'balanced',
                confirmation: 'wrong'
            })
        });
        assert.equal(createBlockedResponse.status, 409);
        assert.equal((await createBlockedResponse.json() as { status: string }).status, 'confirmation_required');

        const createResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                operation: 'create',
                mode: 'execute',
                profile_name: 'custom-review',
                copy_from: 'balanced',
                description: 'Custom profile',
                depth: '3',
                review_policy: {
                    code: 'required',
                    test: 'auto',
                    performance: 'disabled',
                    security: true
                },
                confirmation: 'APPLY PROFILE CHANGE'
            })
        });
        assert.equal(createResponse.status, 200);
        const create = await createResponse.json() as { status: string; audit_path: string };
        assert.equal(create.status, 'executed');
        const createdData = JSON.parse(fs.readFileSync(profilesPath(repoRoot), 'utf8')) as {
            user_profiles: Record<string, { depth: number; review_policy: Record<string, unknown> }>;
        };
        assert.equal(createdData.user_profiles['custom-review'].depth, 3);
        assert.equal(createdData.user_profiles['custom-review'].review_policy.code, true);
        assert.equal(createdData.user_profiles['custom-review'].review_policy.test, 'auto');
        assert.equal(createdData.user_profiles['custom-review'].review_policy.performance, false);
        assert.equal(createdData.user_profiles['custom-review'].review_policy.security, true);
        assert.match(fs.readFileSync(create.audit_path, 'utf8'), /"action_id":"profile:create:custom-review"/u);

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

        const selectResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                operation: 'select',
                mode: 'execute',
                profile_name: 'custom-review',
                confirmation: 'APPLY PROFILE CHANGE'
            })
        });
        assert.equal(selectResponse.status, 200);
        assert.equal((await selectResponse.json() as { status: string }).status, 'executed');
        assert.equal(JSON.parse(fs.readFileSync(profilesPath(repoRoot), 'utf8')).active_profile, 'custom-review');

        const deleteResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                operation: 'delete',
                mode: 'execute',
                profile_name: 'custom-review',
                confirmation: 'APPLY PROFILE CHANGE'
            })
        });
        assert.equal(deleteResponse.status, 200);
        const deletedData = JSON.parse(fs.readFileSync(profilesPath(repoRoot), 'utf8')) as {
            active_profile: string;
            user_profiles: Record<string, unknown>;
        };
        assert.equal(Object.hasOwn(deletedData.user_profiles, 'custom-review'), false);
        assert.equal(deletedData.active_profile, 'balanced');

        const saveBuiltInResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                operation: 'save',
                mode: 'execute',
                profile_name: 'balanced',
                description: 'Locally edited balanced',
                depth: '1',
                review_policy: { code: true, test: true },
                confirmation: 'APPLY PROFILE CHANGE'
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

        const resetResponse = await fetch(`${server.url}api/profiles`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                operation: 'reset',
                mode: 'execute',
                profile_name: 'balanced',
                confirmation: 'APPLY PROFILE CHANGE'
            })
        });
        assert.equal(resetResponse.status, 200);
        assert.equal(JSON.parse(fs.readFileSync(profilesPath(repoRoot), 'utf8')).built_in_profiles.balanced.depth, 2);
    } finally {
        await server.close();
    }
});
