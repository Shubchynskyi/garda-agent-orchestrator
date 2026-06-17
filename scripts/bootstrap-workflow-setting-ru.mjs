import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const ruPackPath = path.join(repoRoot, 'src', 'reports', 'ui', 'lang-packs', 'garda-ui-ru.json');
const outputPath = path.join(repoRoot, 'src', 'reports', 'ui', 'workflow-setting-text', 'lang', 'ru.json');

const sourcePack = JSON.parse(fs.readFileSync(ruPackPath, 'utf8')).LOCAL_UI_SETTING_TEXT;

const booleanOnOff = (onDescription, offDescription) => ({
    options: {
        true: {
            label: 'Включено',
            description: onDescription
        },
        false: {
            label: 'Выключено',
            description: offDescription
        }
    }
});

const booleanPatches = {
    'full-suite-enabled': booleanOnOff(
        'Настроенная команда полной проверки обязательна в жизненном цикле задачи.',
        'Gate полной проверки пропускается, если другой путь workflow не требует его.'
    ),
    'scope-budget-enabled': booleanOnOff(
        'Проверки бюджета охвата предупреждают или блокируют задачу при превышении лимита профиля.',
        'Лимиты бюджета охвата не применяются при оценке размера задачи.'
    ),
    'review-cycle-enabled': booleanOnOff(
        'Повторяющиеся не-test циклы ревью отслеживаются до продолжения closeout.',
        'Давление review-cycle этой защитой не проверяется.'
    ),
    'review-cycle-auto-split-enabled': booleanOnOff(
        'При действии BLOCK_FOR_OPERATOR_DECISION давление review-cycle может выдать подсказку auto-split.',
        'Давление review-cycle никогда не выдаёт подсказку auto-split.'
    ),
    'project-memory-enabled': booleanOnOff(
        'При closeout проверяется, нужны ли доказательства влияния на память проекта.',
        'При closeout не выполняются проверки обслуживания памяти проекта.'
    ),
    'project-memory-run-before-final-closeout': booleanOnOff(
        'Обслуживание памяти проекта выполняется перед финальным шагом завершения.',
        'Обслуживание памяти проекта не вставляется перед финальным closeout.'
    ),
    'project-memory-require-user-approval-for-writes': booleanOnOff(
        'Запись в память проекта требует явного согласия пользователя перед изменением файлов.',
        'Запись в память проекта может выполняться в настроенном режиме обслуживания без отдельного шага согласования.'
    ),
    'task-reset-enabled': booleanOnOff(
        'Подтверждённые команды сброса и отмены задач доступны через защищённые пути.',
        'Мутации сброса и отмены задач недоступны.'
    ),
    'auto-backup-enabled': booleanOnOff(
        'Ежедневное обслуживание может создавать плановые резервные копии для отката, когда наступает интервал.',
        'Ежедневное обслуживание не создаёт плановые резервные копии для отката.'
    )
};

const gardaSelfGuardPatch = {
    options: {
        deny_agent_entry: {
            label: 'Включено',
            description: 'Агенты не могут входить в защищённую работу control-plane без пути, принадлежащего оператору.'
        },
        require_operator_confirmation: {
            label: 'Подтверждение оператора',
            description: 'Вход в защищённый control-plane требует явного подтверждения оператора.'
        }
    }
};

const merged = { ...sourcePack };
for (const [settingId, patch] of Object.entries(booleanPatches)) {
    merged[settingId] = {
        ...merged[settingId],
        ...patch,
        options: {
            ...(merged[settingId]?.options || {}),
            ...patch.options
        }
    };
}
merged['garda-self-guard'] = {
    ...merged['garda-self-guard'],
    ...gardaSelfGuardPatch,
    options: {
        ...merged['garda-self-guard'].options,
        ...gardaSelfGuardPatch.options
    }
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
console.log(`Wrote ${outputPath} (${Object.keys(merged).length} settings)`);
