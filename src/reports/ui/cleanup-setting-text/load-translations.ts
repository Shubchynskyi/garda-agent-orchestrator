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

type CleanupSettingTextPack = Readonly<Record<string, LocalUiLocalizedText>>;

const CLEANUP_SETTING_TEXT_BY_LANGUAGE = Object.freeze({
    ar: Object.freeze(ar as CleanupSettingTextPack),
    bn: Object.freeze(bn as CleanupSettingTextPack),
    de: Object.freeze(de as CleanupSettingTextPack),
    es: Object.freeze(es as CleanupSettingTextPack),
    fr: Object.freeze(fr as CleanupSettingTextPack),
    hi: Object.freeze(hi as CleanupSettingTextPack),
    id: Object.freeze(id as CleanupSettingTextPack),
    it: Object.freeze(it as CleanupSettingTextPack),
    ja: Object.freeze(ja as CleanupSettingTextPack),
    ko: Object.freeze(ko as CleanupSettingTextPack),
    nl: Object.freeze(nl as CleanupSettingTextPack),
    pl: Object.freeze(pl as CleanupSettingTextPack),
    pt: Object.freeze(pt as CleanupSettingTextPack),
    'pt-BR': Object.freeze(ptBr as CleanupSettingTextPack),
    ru: Object.freeze(ru as CleanupSettingTextPack),
    sv: Object.freeze(sv as CleanupSettingTextPack),
    tr: Object.freeze(tr as CleanupSettingTextPack),
    uk: Object.freeze(uk as CleanupSettingTextPack),
    vi: Object.freeze(vi as CleanupSettingTextPack),
    'zh-CN': Object.freeze(zhCn as CleanupSettingTextPack)
} satisfies Readonly<Record<string, CleanupSettingTextPack>>);

export function loadCleanupSettingTextTranslations(): Readonly<Record<string, CleanupSettingTextPack>> {
    return CLEANUP_SETTING_TEXT_BY_LANGUAGE;
}
