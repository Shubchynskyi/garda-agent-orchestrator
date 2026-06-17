import type { LocalUiLocalizedText } from '../ui-language-pack-loader';
import ar from './lang/ar.json';
import bn from './lang/bn.json';
import de from './lang/de.json';
import es from './lang/es.json';
import fr from './lang/fr.json';
import hi from './lang/hi.json';
import id from './lang/id.json';
import it from './lang/it.json';
import ja from './lang/ja.json';
import ko from './lang/ko.json';
import nl from './lang/nl.json';
import pl from './lang/pl.json';
import pt from './lang/pt.json';
import ptBr from './lang/pt-BR.json';
import ru from './lang/ru.json';
import sv from './lang/sv.json';
import tr from './lang/tr.json';
import uk from './lang/uk.json';
import vi from './lang/vi.json';
import zhCn from './lang/zh-CN.json';

type WorkflowSettingTextPack = Readonly<Record<string, LocalUiLocalizedText>>;

const WORKFLOW_SETTING_TEXT_BY_LANGUAGE = Object.freeze({
    ar: Object.freeze(ar as WorkflowSettingTextPack),
    bn: Object.freeze(bn as WorkflowSettingTextPack),
    de: Object.freeze(de as WorkflowSettingTextPack),
    es: Object.freeze(es as WorkflowSettingTextPack),
    fr: Object.freeze(fr as WorkflowSettingTextPack),
    hi: Object.freeze(hi as WorkflowSettingTextPack),
    id: Object.freeze(id as WorkflowSettingTextPack),
    it: Object.freeze(it as WorkflowSettingTextPack),
    ja: Object.freeze(ja as WorkflowSettingTextPack),
    ko: Object.freeze(ko as WorkflowSettingTextPack),
    nl: Object.freeze(nl as WorkflowSettingTextPack),
    pl: Object.freeze(pl as WorkflowSettingTextPack),
    pt: Object.freeze(pt as WorkflowSettingTextPack),
    'pt-BR': Object.freeze(ptBr as WorkflowSettingTextPack),
    ru: Object.freeze(ru as WorkflowSettingTextPack),
    sv: Object.freeze(sv as WorkflowSettingTextPack),
    tr: Object.freeze(tr as WorkflowSettingTextPack),
    uk: Object.freeze(uk as WorkflowSettingTextPack),
    vi: Object.freeze(vi as WorkflowSettingTextPack),
    'zh-CN': Object.freeze(zhCn as WorkflowSettingTextPack)
} satisfies Readonly<Record<string, WorkflowSettingTextPack>>);

export function loadWorkflowSettingTextTranslations(): Readonly<Record<string, WorkflowSettingTextPack>> {
    return WORKFLOW_SETTING_TEXT_BY_LANGUAGE;
}
