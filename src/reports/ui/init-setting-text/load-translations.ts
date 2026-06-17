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

type InitSettingTextPack = Readonly<Record<string, LocalUiLocalizedText>>;

const INIT_SETTING_TEXT_BY_LANGUAGE = Object.freeze({
    ar: Object.freeze(ar as InitSettingTextPack),
    bn: Object.freeze(bn as InitSettingTextPack),
    de: Object.freeze(de as InitSettingTextPack),
    es: Object.freeze(es as InitSettingTextPack),
    fr: Object.freeze(fr as InitSettingTextPack),
    hi: Object.freeze(hi as InitSettingTextPack),
    id: Object.freeze(id as InitSettingTextPack),
    it: Object.freeze(it as InitSettingTextPack),
    ja: Object.freeze(ja as InitSettingTextPack),
    ko: Object.freeze(ko as InitSettingTextPack),
    nl: Object.freeze(nl as InitSettingTextPack),
    pl: Object.freeze(pl as InitSettingTextPack),
    pt: Object.freeze(pt as InitSettingTextPack),
    'pt-BR': Object.freeze(ptBr as InitSettingTextPack),
    ru: Object.freeze(ru as InitSettingTextPack),
    sv: Object.freeze(sv as InitSettingTextPack),
    tr: Object.freeze(tr as InitSettingTextPack),
    uk: Object.freeze(uk as InitSettingTextPack),
    vi: Object.freeze(vi as InitSettingTextPack),
    'zh-CN': Object.freeze(zhCn as InitSettingTextPack)
} satisfies Readonly<Record<string, InitSettingTextPack>>);

export function loadInitSettingTextTranslations(): Readonly<Record<string, InitSettingTextPack>> {
    return INIT_SETTING_TEXT_BY_LANGUAGE;
}
