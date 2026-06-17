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

type ProjectMemoryStatusTextPack = Readonly<Record<string, LocalUiLocalizedText>>;

const PROJECT_MEMORY_STATUS_TEXT_BY_LANGUAGE = Object.freeze({
    ar: Object.freeze(ar as ProjectMemoryStatusTextPack),
    bn: Object.freeze(bn as ProjectMemoryStatusTextPack),
    de: Object.freeze(de as ProjectMemoryStatusTextPack),
    es: Object.freeze(es as ProjectMemoryStatusTextPack),
    fr: Object.freeze(fr as ProjectMemoryStatusTextPack),
    hi: Object.freeze(hi as ProjectMemoryStatusTextPack),
    id: Object.freeze(id as ProjectMemoryStatusTextPack),
    it: Object.freeze(it as ProjectMemoryStatusTextPack),
    ja: Object.freeze(ja as ProjectMemoryStatusTextPack),
    ko: Object.freeze(ko as ProjectMemoryStatusTextPack),
    nl: Object.freeze(nl as ProjectMemoryStatusTextPack),
    pl: Object.freeze(pl as ProjectMemoryStatusTextPack),
    pt: Object.freeze(pt as ProjectMemoryStatusTextPack),
    'pt-BR': Object.freeze(ptBr as ProjectMemoryStatusTextPack),
    ru: Object.freeze(ru as ProjectMemoryStatusTextPack),
    sv: Object.freeze(sv as ProjectMemoryStatusTextPack),
    tr: Object.freeze(tr as ProjectMemoryStatusTextPack),
    uk: Object.freeze(uk as ProjectMemoryStatusTextPack),
    vi: Object.freeze(vi as ProjectMemoryStatusTextPack),
    'zh-CN': Object.freeze(zhCn as ProjectMemoryStatusTextPack)
} satisfies Readonly<Record<string, ProjectMemoryStatusTextPack>>);

export function loadProjectMemoryStatusTextTranslations(): Readonly<Record<string, ProjectMemoryStatusTextPack>> {
    return PROJECT_MEMORY_STATUS_TEXT_BY_LANGUAGE;
}
