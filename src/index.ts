import * as cli from './cli/index';
import * as constants from './core/constants';
import * as coreFs from './core/fs';
import * as json from './core/json';
import * as lineEndings from './core/line-endings';
import * as managedBlocks from './core/managed-blocks';
import * as paths from './core/paths';
import * as templates from './core/templates';
import * as gateRuntime from './gate-runtime/index';
import * as lifecycle from './lifecycle/index';
import * as materialization from './materialization/index';
import * as runtime from './runtime/loaders';
import * as configArtifacts from './schemas/config-artifacts';
import * as initAnswers from './schemas/init-answers';
import * as validators from './validators/index';

export const core = {
    constants,
    fs: coreFs,
    json,
    lineEndings,
    managedBlocks,
    paths,
    templates
};

export const schemas = {
    configArtifacts,
    initAnswers
};

export {
    cli,
    gateRuntime,
    lifecycle,
    materialization,
    runtime,
    validators
};
