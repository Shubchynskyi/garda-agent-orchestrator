import { readJsonFile } from '../core/json';
import { validateManagedConfigByName } from '../schemas/config-artifacts';
import { validateInitAnswers } from '../schemas/init-answers';

export function loadInitAnswersFile(filePath: string) {
    return validateInitAnswers(readJsonFile(filePath));
}

export function loadManagedConfigFile(configName: string, filePath: string) {
    return validateManagedConfigByName(configName, readJsonFile(filePath));
}
