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

type BackupsTabTextPack = Readonly<Record<string, LocalUiLocalizedText>>;

const BACKUPS_TAB_TEXT_BY_LANGUAGE = Object.freeze({
    ar: Object.freeze(ar as BackupsTabTextPack),
    bn: Object.freeze(bn as BackupsTabTextPack),
    de: Object.freeze(de as BackupsTabTextPack),
    es: Object.freeze(es as BackupsTabTextPack),
    fr: Object.freeze(fr as BackupsTabTextPack),
    hi: Object.freeze(hi as BackupsTabTextPack),
    id: Object.freeze(id as BackupsTabTextPack),
    it: Object.freeze(it as BackupsTabTextPack),
    ja: Object.freeze(ja as BackupsTabTextPack),
    ko: Object.freeze(ko as BackupsTabTextPack),
    nl: Object.freeze(nl as BackupsTabTextPack),
    pl: Object.freeze(pl as BackupsTabTextPack),
    pt: Object.freeze(pt as BackupsTabTextPack),
    'pt-BR': Object.freeze(ptBr as BackupsTabTextPack),
    ru: Object.freeze(ru as BackupsTabTextPack),
    sv: Object.freeze(sv as BackupsTabTextPack),
    tr: Object.freeze(tr as BackupsTabTextPack),
    uk: Object.freeze(uk as BackupsTabTextPack),
    vi: Object.freeze(vi as BackupsTabTextPack),
    'zh-CN': Object.freeze(zhCn as BackupsTabTextPack)
} satisfies Readonly<Record<string, BackupsTabTextPack>>);

export function loadBackupsTabTextTranslations(): Readonly<Record<string, BackupsTabTextPack>> {
    return BACKUPS_TAB_TEXT_BY_LANGUAGE;
}
