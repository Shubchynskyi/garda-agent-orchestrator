import { createLocalUiTranslationLoader, type LocalUiTranslationPacks } from '../ui-i18n-loader-factory';
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

const loadTranslations = createLocalUiTranslationLoader({
    ar, bn, de, es, fr, hi, id, it, ja, ko,
    nl, pl, pt, 'pt-BR': ptBr, ru, sv, tr, uk, vi, 'zh-CN': zhCn
});

export function loadWorkflowSettingTextTranslations(): LocalUiTranslationPacks {
    return loadTranslations();
}
