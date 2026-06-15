import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    cleanupLocalUiTestResources,
    makeLocalUiTempRepo
} from './local-ui-test-helpers';

test('local UI cleanup removes temp repo while preserving server close failures', async () => {
    const repoRoot = makeLocalUiTempRepo();
    fs.writeFileSync(path.join(repoRoot, 'marker.txt'), 'cleanup');

    await assert.rejects(
        () => cleanupLocalUiTestResources({
            repoRoot,
            server: {
                close: async () => {
                    throw new Error('close failed');
                }
            }
        }),
        /close failed/u
    );
    assert.equal(fs.existsSync(repoRoot), false);
});
