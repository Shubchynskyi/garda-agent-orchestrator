import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packsDir = path.join(repoRoot, 'src', 'reports', 'ui', 'lang-packs');

const PROJECT_MEMORY_INSTRUCTION = {
    ar: {
        title: 'ذاكرة المشروع',
        body: 'تعرض علامة تبويب ذاكرة المشروع وضع الصيانة الحالي وملفات الذاكرة الدائمة. افتح كل ملف عند الطلب بدلاً من تحميل المحتوى الكامل في لوحة المعلومات.'
    },
    bn: {
        title: 'প্রকল্প মেমরি',
        body: 'প্রকল্প মেমরি ট্যাবে বর্তমান রক্ষণাবেক্ষণ মোড এবং স্থায়ী মেমরি ফাইল দেখায়। ড্যাশবোর্ডে পুরো কনটেন্ট লোড না করে প্রয়োজন অনুযায়ী প্রতিটি ফাইল খুলুন।'
    },
    de: {
        title: 'Projektspeicher',
        body: 'Die Registerkarte Projektspeicher zeigt den aktuellen Wartungsmodus und die dauerhaften Projektspeicherdateien. Öffnen Sie jede Datei bei Bedarf, statt den vollständigen Inhalt ins Dashboard zu laden.'
    },
    es: {
        title: 'Memoria del proyecto',
        body: 'La pestaña de memoria del proyecto muestra el modo de mantenimiento actual y los archivos de memoria duradera. Abra cada archivo bajo demanda en lugar de cargar el contenido completo en el panel.'
    },
    fr: {
        title: 'Mémoire du projet',
        body: 'L’onglet mémoire du projet affiche le mode de maintenance actuel et les fichiers de mémoire durable. Ouvrez chaque fichier à la demande au lieu de charger tout le contenu dans le tableau de bord.'
    },
    hi: {
        title: 'प्रोजेक्ट मेमोरी',
        body: 'प्रोजेक्ट मेमोरी टैब वर्तमान रखरखाव मोड और टिकाऊ मेमोरी फ़ाइलें दिखाता है। पूरा कंटेंट डैशबोर्ड में लोड करने के बजाय प्रत्येक फ़ाइल को मांग पर खोलें।'
    },
    id: {
        title: 'Memori proyek',
        body: 'Tab memori proyek menampilkan mode pemeliharaan saat ini dan file memori tahan lama. Buka setiap file sesuai permintaan alih-alih memuat seluruh konten ke dashboard.'
    },
    it: {
        title: 'Memoria del progetto',
        body: 'La scheda memoria del progetto mostra la modalità di manutenzione corrente e i file di memoria durevole. Apri ogni file su richiesta invece di caricare l’intero contenuto nella dashboard.'
    },
    ja: {
        title: 'プロジェクトメモリ',
        body: 'プロジェクトメモリタブには現在のメンテナンスモードと永続的なメモリファイルが表示されます。ダッシュボードに全文を読み込まず、必要に応じて各ファイルを開いてください。'
    },
    ko: {
        title: '프로젝트 메모리',
        body: '프로젝트 메모리 탭에는 현재 유지보수 모드와 영구 메모리 파일이 표시됩니다. 대시보드에 전체 내용을 로드하지 말고 필요할 때 각 파일을 여세요.'
    },
    nl: {
        title: 'Projectgeheugen',
        body: 'Het tabblad projectgeheugen toont de huidige onderhoudsmodus en duurzame geheugenbestanden. Open elk bestand op aanvraag in plaats van de volledige inhoud in het dashboard te laden.'
    },
    pl: {
        title: 'Pamięć projektu',
        body: 'Karta pamięci projektu pokazuje bieżący tryb konserwacji i trwałe pliki pamięci. Otwieraj każdy plik na żądanie zamiast ładować całą zawartość do panelu.'
    },
    pt: {
        title: 'Memória do projeto',
        body: 'O separador de memória do projeto mostra o modo de manutenção atual e os ficheiros de memória durável. Abra cada ficheiro sob pedido em vez de carregar todo o conteúdo no painel.'
    },
    'pt-BR': {
        title: 'Memória do projeto',
        body: 'A aba de memória do projeto mostra o modo de manutenção atual e os arquivos de memória durável. Abra cada arquivo sob demanda em vez de carregar todo o conteúdo no painel.'
    },
    ru: {
        title: 'Память проекта',
        body: 'Вкладка памяти проекта показывает текущий режим обслуживания и файлы устойчивой памяти. Полный файл открывается по запросу в новой вкладке, а не грузится целиком в dashboard.'
    },
    sv: {
        title: 'Projektminne',
        body: 'Fliken projektminne visar aktuellt underhållsläge och beständiga minnesfiler. Öppna varje fil på begäran i stället för att ladda hela innehållet i instrumentpanelen.'
    },
    tr: {
        title: 'Proje belleği',
        body: 'Proje belleği sekmesi geçerli bakım modunu ve kalıcı bellek dosyalarını gösterir. Tüm içeriği panele yüklemek yerine her dosyayı isteğe bağlı açın.'
    },
    uk: {
        title: 'Памʼять проєкту',
        body: 'Вкладка памʼяті проєкту показує поточний режим обслуговування та файли стійкої памʼяті. Повний файл відкривається за запитом, а не завантажується цілком у dashboard.'
    },
    vi: {
        title: 'Bộ nhớ dự án',
        body: 'Tab bộ nhớ dự án hiển thị chế độ bảo trì hiện tại và các tệp bộ nhớ bền vững. Mở từng tệp theo yêu cầu thay vì tải toàn bộ nội dung vào bảng điều khiển.'
    },
    'zh-CN': {
        title: '项目记忆',
        body: '项目记忆选项卡显示当前维护模式和持久记忆文件。请按需打开每个文件，而不是将全部内容加载到仪表板中。'
    }
};

for (const fileName of fs.readdirSync(packsDir).filter((name) => name.startsWith('garda-ui-') && name.endsWith('.json'))) {
    const langId = fileName.slice('garda-ui-'.length, -'.json'.length);
    const instruction = PROJECT_MEMORY_INSTRUCTION[langId];
    if (!instruction) {
        console.warn(`skip ${fileName}: no instruction map`);
        continue;
    }

    const filePath = path.join(packsDir, fileName);
    const pack = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!pack.LOCAL_UI_INSTRUCTION_TEXT || typeof pack.LOCAL_UI_INSTRUCTION_TEXT !== 'object') {
        pack.LOCAL_UI_INSTRUCTION_TEXT = {};
    }
    pack.LOCAL_UI_INSTRUCTION_TEXT['project-memory'] = instruction;
    fs.writeFileSync(filePath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
    console.log(`patched ${fileName}`);
}

console.log('done');
