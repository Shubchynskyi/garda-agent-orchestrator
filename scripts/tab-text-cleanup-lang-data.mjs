export const CLEANUP_TAB_TEXT_BY_LANGUAGE = {
  ar: {
    tab_intro: {
      description: 'سياسة الاحتفاظ ببيانات runtime في `runtime-retention.json`: حدود الصيانة المجدولة، وقواعد الدمج، وإجراءات التنظيف اليدوي المحمية.'
    },
    daily_maintenance_enabled: {
      label: 'الصيانة اليومية',
      description: 'يشغّل الصيانة اليومية المجدولة أو يوقفها. عند التفعيل، يستطيع المنسّق معالجة دفعة محدودة من المهام المؤهلة وفق الجدول من دون تدخل يدوي.'
    },
    daily_maintenance_max_tasks_per_run: {
      label: 'الحد الأقصى للمهام في كل تشغيل صيانة',
      description: 'الحد الأعلى لعدد المهام المؤهلة التي تعالجها الصيانة اليومية في التشغيل الواحد. يقلّل نطاق التأثير إذا كانت الحدود مضبوطة بشكل خاطئ.'
    },
    eligible_older_than_days: {
      label: 'الحد الأدنى لعمر المهمة (بالأيام)',
      description: 'يجب أن يكون عمر المهمة بهذا العدد من الأيام على الأقل قبل أن تتمكن الصيانة أو التنظيف اليدوي من لمس بيانات runtime الخاصة بها. تبقى المهام النشطة والأحدث محمية.'
    },
    keep_latest_tasks: {
      label: 'الاحتفاظ بأحدث المهام (العدد)',
      description: 'يحافظ دائماً على هذا العدد الأدنى من أحدث المهام حتى لو كانت أقدم من حد العمر. اضبط القيمة على 0 للاعتماد على العمر فقط مع حماية المهام النشطة.'
    },
    daily_maintenance_dry_run: {
      label: 'تشغيل تجريبي للصيانة اليومية',
      description: 'عند ضبطه على true، تكتفي الصيانة اليومية المجدولة بسرد المرشحين وكتابة سجل التدقيق؛ ولا تحذف أو تضغط أي ملفات. استخدم true أثناء ضبط الحدود، ثم بدّل إلى false للتطبيق.'
    },
    purge_require_confirm: {
      label: 'اشتراط تأكيد الحذف',
      description: 'عند ضبطه على true، تتطلب أوامر الحذف والتنظيف المدمّرة إدخال عبارة تأكيد صريحة قبل أن ينفّذها الخادم.'
    },
    healthy_done_compact_after_days: {
      label: 'دمج مهام DONE السليمة بعد (أيام)',
      description: 'بعد هذا العدد من الأيام، يمكن دمج المهام المكتملة بنجاح (DONE) إلى سجل موجز فقط بعد التحقق من سلامة أدلة السجل.'
    },
    problem_tasks_compress_after_days: {
      label: 'ضغط المهام المتعثرة بعد (أيام)',
      description: 'بعد هذا العدد من الأيام، يمكن ضغط الملفات الجنائية الكبيرة للمهام الفاشلة أو العالقة مع الإبقاء على الأدلة القابلة للقراءة أثناء الاستعادة.'
    },
    manual_runtime_cleanup: {
      label: 'تنظيف runtime اليدوي',
      description: 'يشغّل `garda cleanup` مرة واحدة باستخدام قيم العمر والاحتفاظ بأحدث المهام من الصفوف أعلاه. تعرض المعاينة المرشحين فقط؛ أما التطبيق فيحذف أو يضغط وفق السياسة ويتطلب تأكيداً.'
    },
    task_purge: {
      label: 'حذف بيانات المهمة',
      description: 'يحذف ملفات runtime المملوكة لمعرّف مهمة واحد ويصلح الفهارس المشتركة. لا يزيل الملفات المشتركة بالكامل؛ وتبقى حماية المهام النشطة مطبقة على الخادم.'
    },
    task_id: {
      label: 'معرّف المهمة'
    },
    purge_task_button: {
      label: 'حذف المهمة'
    },
    run_preview: {
      label: 'معاينة'
    },
    value_true: {
      label: 'true — مفعّل'
    },
    value_false: {
      label: 'false — معطّل'
    }
  },
  bn: {
    tab_intro: {
      description: '`runtime-retention.json`-এ runtime সংরক্ষণ নীতি: নির্ধারিত রক্ষণাবেক্ষণের সীমা, কমপ্যাকশন নীতি, এবং সুরক্ষিত ম্যানুয়াল ক্লিনআপ কার্যক্রম।'
    },
    daily_maintenance_enabled: {
      label: 'দৈনিক রক্ষণাবেক্ষণ',
      description: 'নির্ধারিত দৈনিক রক্ষণাবেক্ষণ চালু বা বন্ধ করে। চালু থাকলে, orchestrator ম্যানুয়াল হস্তক্ষেপ ছাড়াই সময়সূচি অনুযায়ী সীমিত সংখ্যক উপযুক্ত টাস্ক প্রক্রিয়া করতে পারে।'
    },
    daily_maintenance_max_tasks_per_run: {
      label: 'প্রতি রক্ষণাবেক্ষণ রানে সর্বোচ্চ টাস্ক',
      description: 'একটি রানে দৈনিক রক্ষণাবেক্ষণ কতগুলো উপযুক্ত টাস্ক প্রক্রিয়া করতে পারবে তার ঊর্ধ্বসীমা। থ্রেশহোল্ড ভুল কনফিগার হলে প্রভাবের পরিধি সীমিত রাখে।'
    },
    eligible_older_than_days: {
      label: 'টাস্কের ন্যূনতম বয়স (দিন)',
      description: 'রক্ষণাবেক্ষণ বা ম্যানুয়াল ক্লিনআপ কোনো টাস্কের runtime আর্টিফ্যাক্ট স্পর্শ করার আগে টাস্কটির বয়স অন্তত এত দিন হতে হবে। সক্রিয় এবং নতুন টাস্ক সুরক্ষিত থাকে।'
    },
    keep_latest_tasks: {
      label: 'সর্বশেষ টাস্ক রেখে দিন (সংখ্যা)',
      description: 'বয়সসীমা পেরিয়ে গেলেও অন্তত এতগুলো সর্বশেষ টাস্ক সব সময় সংরক্ষিত থাকবে। শুধুমাত্র বয়স এবং সক্রিয় টাস্ক সুরক্ষার ওপর নির্ভর করতে 0 দিন।'
    },
    daily_maintenance_dry_run: {
      label: 'দৈনিক রক্ষণাবেক্ষণ dry-run',
      description: 'মান true হলে, নির্ধারিত দৈনিক রক্ষণাবেক্ষণ শুধু প্রার্থী তালিকা করে এবং অডিট আউটপুট লেখে; কোনো আর্টিফ্যাক্ট মুছে ফেলে বা কমপ্রেস করে না। থ্রেশহোল্ড ঠিক করার সময় true রাখুন, পরে প্রয়োগের জন্য false করুন।'
    },
    purge_require_confirm: {
      label: 'মোছার আগে নিশ্চিতকরণ আবশ্যক',
      description: 'মান true হলে, ধ্বংসাত্মক purge ও cleanup কমান্ড চালানোর আগে সার্ভার স্পষ্টভাবে টাইপ করা নিশ্চিতকরণ বাক্যাংশ চাইবে।'
    },
    healthy_done_compact_after_days: {
      label: 'সুস্থ DONE টাস্ক কমপ্যাক্ট করুন (দিন পরে)',
      description: 'এত দিন পরে, সফলভাবে সমাপ্ত (DONE) টাস্কগুলো ledger প্রমাণ যাচাই হলে শুধু ledger-ভিত্তিক ইতিহাসে কমপ্যাক্ট করা যেতে পারে।'
    },
    problem_tasks_compress_after_days: {
      label: 'সমস্যাযুক্ত টাস্ক কমপ্রেস করুন (দিন পরে)',
      description: 'এত দিন পরে, ব্যর্থ বা আটকে থাকা টাস্কের ভারী ফরেনসিক আর্টিফ্যাক্ট কমপ্রেস করা যেতে পারে, তবে পুনরুদ্ধারযোগ্য পাঠযোগ্য প্রমাণ রাখা হবে।'
    },
    manual_runtime_cleanup: {
      label: 'ম্যানুয়াল runtime ক্লিনআপ',
      description: 'উপরের সারির বয়স এবং keep-latest মান ব্যবহার করে একবার `garda cleanup` চালায়। Preview কেবল প্রার্থী দেখায়; Apply নীতিমালা অনুযায়ী মুছে ফেলে বা কমপ্রেস করে এবং নিশ্চিতকরণ চায়।'
    },
    task_purge: {
      label: 'টাস্ক purge',
      description: 'একটি টাস্ক ID-এর মালিকানাধীন runtime আর্টিফ্যাক্ট মুছে দেয় এবং শেয়ার করা ইনডেক্স মেরামত করে। সম্পূর্ণ শেয়ার করা ফাইল সরায় না; সার্ভার-সাইডে সক্রিয় টাস্ক সুরক্ষা বহাল থাকে।'
    },
    task_id: {
      label: 'টাস্ক ID'
    },
    purge_task_button: {
      label: 'টাস্ক purge করুন'
    },
    run_preview: {
      label: 'প্রিভিউ'
    },
    value_true: {
      label: 'true — সক্রিয়'
    },
    value_false: {
      label: 'false — নিষ্ক্রিয়'
    }
  },
  de: {
    tab_intro: {
      description: 'Aufbewahrungsrichtlinie für Runtime-Daten in `runtime-retention.json`: Schwellenwerte für geplante Wartung, Regeln zur Verdichtung und geschützte manuelle Bereinigungsaktionen.'
    },
    daily_maintenance_enabled: {
      label: 'Tägliche Wartung',
      description: 'Schaltet die geplante tägliche Wartung ein oder aus. Wenn sie aktiviert ist, kann der Orchestrator nach Zeitplan eine begrenzte Anzahl geeigneter Aufgaben ohne manuelles Eingreifen verarbeiten.'
    },
    daily_maintenance_max_tasks_per_run: {
      label: 'Max. Aufgaben pro Wartungslauf',
      description: 'Obergrenze dafür, wie viele geeignete Aufgaben die tägliche Wartung in einem einzelnen Lauf verarbeitet. Begrenzt den möglichen Schaden, wenn Schwellenwerte falsch konfiguriert sind.'
    },
    eligible_older_than_days: {
      label: 'Mindestalter der Aufgabe (Tage)',
      description: 'Eine Aufgabe muss mindestens so viele Tage alt sein, bevor Wartung oder manuelle Bereinigung ihre Runtime-Artefakte anfassen dürfen. Aktive und neuere Aufgaben bleiben geschützt.'
    },
    keep_latest_tasks: {
      label: 'Neueste Aufgaben behalten (Anzahl)',
      description: 'Bewahrt immer mindestens so viele der neuesten Aufgaben auf, auch wenn sie älter als die Altersgrenze sind. Auf 0 setzen, um sich nur auf Alter und Schutz aktiver Aufgaben zu verlassen.'
    },
    daily_maintenance_dry_run: {
      label: 'Tägliche Wartung als Dry-Run',
      description: 'Wenn true gesetzt ist, listet die geplante tägliche Wartung nur Kandidaten auf und schreibt Audit-Ausgaben; Artefakte werden weder gelöscht noch komprimiert. Verwenden Sie true beim Feinabstimmen der Grenzwerte und wechseln Sie danach zu false für die Anwendung.'
    },
    purge_require_confirm: {
      label: 'Bestätigung für Purge erforderlich',
      description: 'Wenn true gesetzt ist, verlangen zerstörerische Purge- und Cleanup-Befehle eine explizit eingegebene Bestätigungsphrase, bevor der Server sie ausführt.'
    },
    healthy_done_compact_after_days: {
      label: 'Erfolgreiche DONE nach (Tagen) verdichten',
      description: 'Nach so vielen Tagen dürfen erfolgreich abgeschlossene Aufgaben (DONE) auf eine reine Ledger-Historie verdichtet werden, sobald der Ledger-Nachweis verifiziert ist.'
    },
    problem_tasks_compress_after_days: {
      label: 'Problematische Aufgaben nach (Tagen) komprimieren',
      description: 'Nach so vielen Tagen dürfen umfangreiche forensische Artefakte fehlgeschlagener oder hängengebliebener Aufgaben komprimiert werden, solange lesbare Wiederherstellungsnachweise erhalten bleiben.'
    },
    manual_runtime_cleanup: {
      label: 'Manuelle Runtime-Bereinigung',
      description: 'Führt `garda cleanup` einmal mit den Werten für Alter und Neueste-behalten aus den Zeilen oben aus. Die Vorschau zeigt nur Kandidaten; Anwenden löscht oder komprimiert gemäß Richtlinie und verlangt eine Bestätigung.'
    },
    task_purge: {
      label: 'Aufgaben-Purge',
      description: 'Löscht Runtime-Artefakte, die zu einer einzelnen Aufgaben-ID gehören, und repariert gemeinsame Indizes. Ganze gemeinsame Dateien werden nicht entfernt; der Schutz aktiver Aufgaben gilt serverseitig weiterhin.'
    },
    task_id: {
      label: 'Aufgaben-ID'
    },
    purge_task_button: {
      label: 'Aufgabe löschen'
    },
    run_preview: {
      label: 'Vorschau'
    },
    value_true: {
      label: 'true — aktiviert'
    },
    value_false: {
      label: 'false — deaktiviert'
    }
  },
  es: {
    tab_intro: {
      description: 'Política de retención de runtime en `runtime-retention.json`: umbrales de mantenimiento programado, reglas de compactación y acciones protegidas de limpieza manual.'
    },
    daily_maintenance_enabled: {
      label: 'Mantenimiento diario',
      description: 'Activa o desactiva el mantenimiento diario programado. Cuando está habilitado, el orquestador puede procesar por horario un lote limitado de tareas aptas sin intervención manual.'
    },
    daily_maintenance_max_tasks_per_run: {
      label: 'Máximo de tareas por ejecución de mantenimiento',
      description: 'Límite superior de cuántas tareas aptas procesa el mantenimiento diario en una sola ejecución. Reduce el alcance del impacto si los umbrales están mal configurados.'
    },
    eligible_older_than_days: {
      label: 'Edad mínima de la tarea (días)',
      description: 'Una tarea debe tener al menos esta cantidad de días antes de que el mantenimiento o la limpieza manual puedan tocar sus artefactos de runtime. Las tareas activas y más recientes permanecen protegidas.'
    },
    keep_latest_tasks: {
      label: 'Conservar las tareas más recientes (cantidad)',
      description: 'Conserva siempre al menos esta cantidad de tareas más recientes, aunque sean más antiguas que el umbral de edad. Usa 0 para depender solo de la edad y de la protección de tareas activas.'
    },
    daily_maintenance_dry_run: {
      label: 'Dry-run de mantenimiento diario',
      description: 'Cuando es true, el mantenimiento diario programado solo enumera candidatos y escribe salida de auditoría; no elimina ni comprime artefactos. Usa true mientras ajustas los umbrales y luego cambia a false para aplicar.'
    },
    purge_require_confirm: {
      label: 'Confirmación obligatoria para purga',
      description: 'Cuando es true, los comandos destructivos de purga y limpieza requieren una frase de confirmación escrita explícitamente antes de que el servidor los ejecute.'
    },
    healthy_done_compact_after_days: {
      label: 'Compactar DONE correctas después de (días)',
      description: 'Después de esta cantidad de días, las tareas completadas con éxito (DONE) pueden compactarse a un historial solo de ledger una vez verificada la evidencia del ledger.'
    },
    problem_tasks_compress_after_days: {
      label: 'Comprimir tareas problemáticas después de (días)',
      description: 'Después de esta cantidad de días, las tareas fallidas o atascadas pueden tener sus artefactos forenses pesados comprimidos, manteniendo evidencia legible para recuperación.'
    },
    manual_runtime_cleanup: {
      label: 'Limpieza manual de runtime',
      description: 'Ejecuta `garda cleanup` una vez con los valores de antigüedad y conservar-las-más-recientes de las filas anteriores. La vista previa solo muestra candidatos; Aplicar elimina o comprime según la política y requiere confirmación.'
    },
    task_purge: {
      label: 'Purga de tarea',
      description: 'Elimina artefactos de runtime pertenecientes a un único ID de tarea y repara índices compartidos. No elimina archivos compartidos completos; la protección de tareas activas sigue aplicándose en el servidor.'
    },
    task_id: {
      label: 'ID de tarea'
    },
    purge_task_button: {
      label: 'Purgar tarea'
    },
    run_preview: {
      label: 'Vista previa'
    },
    value_true: {
      label: 'true — habilitado'
    },
    value_false: {
      label: 'false — deshabilitado'
    }
  },
  fr: {
    tab_intro: {
      description: 'Politique de rétention du runtime dans `runtime-retention.json` : seuils de maintenance planifiée, règles de compactage et actions de nettoyage manuel protégées.'
    },
    daily_maintenance_enabled: {
      label: 'Maintenance quotidienne',
      description: 'Active ou désactive la maintenance quotidienne planifiée. Lorsqu’elle est activée, l’orchestrateur peut traiter selon le planning un lot limité de tâches éligibles sans intervention manuelle.'
    },
    daily_maintenance_max_tasks_per_run: {
      label: 'Nombre maximal de tâches par exécution',
      description: 'Limite supérieure du nombre de tâches éligibles que la maintenance quotidienne traite en une seule exécution. Réduit l’ampleur de l’impact si les seuils sont mal configurés.'
    },
    eligible_older_than_days: {
      label: 'Âge minimal de la tâche (jours)',
      description: 'Une tâche doit avoir au moins cet âge avant que la maintenance ou le nettoyage manuel puissent toucher à ses artefacts runtime. Les tâches actives et plus récentes restent protégées.'
    },
    keep_latest_tasks: {
      label: 'Conserver les tâches les plus récentes (nombre)',
      description: 'Conserve toujours au moins ce nombre de tâches les plus récentes, même si elles sont plus anciennes que le seuil d’âge. Mettez 0 pour ne vous appuyer que sur l’âge et la protection des tâches actives.'
    },
    daily_maintenance_dry_run: {
      label: 'Maintenance quotidienne en dry-run',
      description: 'Quand la valeur est true, la maintenance quotidienne planifiée se contente de lister les candidats et d’écrire une sortie d’audit ; elle ne supprime ni ne compresse aucun artefact. Utilisez true pendant le réglage des seuils, puis passez à false pour appliquer.'
    },
    purge_require_confirm: {
      label: 'Confirmation de purge requise',
      description: 'Quand la valeur est true, les commandes destructrices de purge et de nettoyage exigent une phrase de confirmation saisie explicitement avant exécution par le serveur.'
    },
    healthy_done_compact_after_days: {
      label: 'Compacter les DONE saines après (jours)',
      description: 'Après ce nombre de jours, les tâches terminées avec succès (DONE) peuvent être compactées en historique de ledger uniquement une fois la preuve du ledger vérifiée.'
    },
    problem_tasks_compress_after_days: {
      label: 'Compresser les tâches problématiques après (jours)',
      description: 'Après ce nombre de jours, les tâches en échec ou bloquées peuvent voir leurs artefacts forensiques volumineux compressés tout en conservant des preuves lisibles pour la reprise.'
    },
    manual_runtime_cleanup: {
      label: 'Nettoyage manuel du runtime',
      description: 'Exécute `garda cleanup` une fois avec les valeurs d’âge et de conservation des plus récentes définies ci-dessus. L’aperçu montre seulement les candidats ; Appliquer supprime ou compresse selon la politique et exige une confirmation.'
    },
    task_purge: {
      label: 'Purge de tâche',
      description: 'Supprime les artefacts runtime appartenant à un seul ID de tâche et répare les index partagés. Ne supprime pas des fichiers partagés entiers ; la protection des tâches actives continue de s’appliquer côté serveur.'
    },
    task_id: {
      label: 'ID de tâche'
    },
    purge_task_button: {
      label: 'Purger la tâche'
    },
    run_preview: {
      label: 'Aperçu'
    },
    value_true: {
      label: 'true — activé'
    },
    value_false: {
      label: 'false — désactivé'
    }
  },
  hi: {
    tab_intro: {
      description: '`runtime-retention.json` में runtime प्रतिधारण नीति: निर्धारित रखरखाव सीमाएँ, compact करने के नियम, और सुरक्षित मैनुअल cleanup क्रियाएँ।'
    },
    daily_maintenance_enabled: {
      label: 'दैनिक रखरखाव',
      description: 'निर्धारित दैनिक रखरखाव को चालू या बंद करता है। सक्षम होने पर orchestrator बिना मैनुअल हस्तक्षेप के समयानुसार सीमित संख्या में योग्य कार्यों को प्रोसेस कर सकता है।'
    },
    daily_maintenance_max_tasks_per_run: {
      label: 'प्रति रखरखाव रन अधिकतम कार्य',
      description: 'एक रन में दैनिक रखरखाव कितने योग्य कार्य प्रोसेस करेगा इसकी ऊपरी सीमा। यदि थ्रेशहोल्ड गलत कॉन्फ़िगर हों तो प्रभाव का दायरा सीमित रहता है।'
    },
    eligible_older_than_days: {
      label: 'कार्य की न्यूनतम आयु (दिन)',
      description: 'किसी कार्य के runtime artifact को maintenance या manual cleanup छू सके, उससे पहले उसका इतना पुराना होना आवश्यक है। सक्रिय और नए कार्य सुरक्षित रहते हैं।'
    },
    keep_latest_tasks: {
      label: 'नवीनतम कार्य सुरक्षित रखें (संख्या)',
      description: 'उम्र सीमा पार होने पर भी कम से कम इतने सबसे हाल के कार्य हमेशा सुरक्षित रखे जाते हैं। केवल उम्र और active-task सुरक्षा पर निर्भर रहने के लिए 0 सेट करें।'
    },
    daily_maintenance_dry_run: {
      label: 'दैनिक रखरखाव dry-run',
      description: 'जब मान true हो, निर्धारित दैनिक रखरखाव केवल उम्मीदवारों की सूची बनाता है और audit output लिखता है; कोई artifact हटाता या compress नहीं करता। थ्रेशहोल्ड ठीक करते समय true रखें, फिर लागू करने के लिए false करें।'
    },
    purge_require_confirm: {
      label: 'purge के लिए पुष्टि आवश्यक',
      description: 'जब मान true हो, destructive purge और cleanup कमांड चलाने से पहले सर्वर स्पष्ट रूप से टाइप किया गया confirmation phrase मांगता है।'
    },
    healthy_done_compact_after_days: {
      label: 'स्वस्थ DONE को इतने दिन बाद compact करें',
      description: 'इतने दिनों बाद सफलतापूर्वक पूर्ण (DONE) कार्यों को ledger evidence सत्यापित होने पर केवल ledger-history में compact किया जा सकता है।'
    },
    problem_tasks_compress_after_days: {
      label: 'समस्याग्रस्त कार्य इतने दिन बाद compress करें',
      description: 'इतने दिनों बाद विफल या अटके हुए कार्यों के भारी forensic artifact compress किए जा सकते हैं, जबकि recovery के लिए पढ़ने योग्य evidence सुरक्षित रहता है।'
    },
    manual_runtime_cleanup: {
      label: 'मैनुअल runtime cleanup',
      description: 'ऊपर की पंक्तियों से आयु और keep-latest मान लेकर `garda cleanup` एक बार चलाता है। Preview केवल उम्मीदवार दिखाता है; Apply नीति के अनुसार हटाता या compress करता है और पुष्टि मांगता है।'
    },
    task_purge: {
      label: 'कार्य purge',
      description: 'एक task ID के स्वामित्व वाले runtime artifact हटाता है और shared index की मरम्मत करता है। पूरे shared file नहीं हटाता; server पर active-task सुरक्षा लागू रहती है।'
    },
    task_id: {
      label: 'कार्य ID'
    },
    purge_task_button: {
      label: 'कार्य purge करें'
    },
    run_preview: {
      label: 'पूर्वावलोकन'
    },
    value_true: {
      label: 'true — सक्षम'
    },
    value_false: {
      label: 'false — अक्षम'
    }
  },
  id: {
    tab_intro: {
      description: 'Kebijakan retensi runtime di `runtime-retention.json`: ambang pemeliharaan terjadwal, aturan pemadatan, dan tindakan pembersihan manual yang terlindungi.'
    },
    daily_maintenance_enabled: {
      label: 'Pemeliharaan harian',
      description: 'Mengaktifkan atau menonaktifkan pemeliharaan harian terjadwal. Saat aktif, orkestrator dapat memproses sejumlah terbatas tugas yang memenuhi syarat sesuai jadwal tanpa intervensi manual.'
    },
    daily_maintenance_max_tasks_per_run: {
      label: 'Maksimum tugas per proses pemeliharaan',
      description: 'Batas atas jumlah tugas yang memenuhi syarat yang diproses pemeliharaan harian dalam satu kali jalan. Membatasi dampak jika ambang dikonfigurasi secara keliru.'
    },
    eligible_older_than_days: {
      label: 'Usia minimum tugas (hari)',
      description: 'Sebuah tugas harus berusia setidaknya selama ini sebelum pemeliharaan atau pembersihan manual boleh menyentuh artefak runtime miliknya. Tugas aktif dan tugas yang lebih baru tetap dilindungi.'
    },
    keep_latest_tasks: {
      label: 'Pertahankan tugas terbaru (jumlah)',
      description: 'Selalu simpan setidaknya sebanyak ini tugas terbaru meskipun usianya melebihi ambang umur. Setel ke 0 untuk hanya mengandalkan umur dan perlindungan tugas aktif.'
    },
    daily_maintenance_dry_run: {
      label: 'Dry-run pemeliharaan harian',
      description: 'Saat bernilai true, pemeliharaan harian terjadwal hanya menampilkan kandidat dan menulis keluaran audit; tidak menghapus atau mengompresi artefak. Gunakan true saat menyetel ambang, lalu ubah ke false untuk menerapkan.'
    },
    purge_require_confirm: {
      label: 'Purge wajib konfirmasi',
      description: 'Saat bernilai true, perintah purge dan cleanup yang destruktif memerlukan frasa konfirmasi yang diketik secara eksplisit sebelum server mengeksekusinya.'
    },
    healthy_done_compact_after_days: {
      label: 'Padatkan DONE yang sehat setelah (hari)',
      description: 'Setelah selama ini, tugas yang berhasil selesai (DONE) dapat dipadatkan menjadi riwayat ledger saja setelah bukti ledger diverifikasi.'
    },
    problem_tasks_compress_after_days: {
      label: 'Kompres tugas bermasalah setelah (hari)',
      description: 'Setelah selama ini, artefak forensik besar dari tugas yang gagal atau macet dapat dikompresi sambil tetap menyimpan bukti yang dapat dibaca untuk pemulihan.'
    },
    manual_runtime_cleanup: {
      label: 'Pembersihan runtime manual',
      description: 'Menjalankan `garda cleanup` sekali dengan nilai umur dan pertahankan-terbaru dari baris di atas. Pratinjau hanya menampilkan kandidat; Terapkan menghapus atau mengompresi sesuai kebijakan dan memerlukan konfirmasi.'
    },
    task_purge: {
      label: 'Purge tugas',
      description: 'Menghapus artefak runtime milik satu ID tugas dan memperbaiki indeks bersama. Tidak menghapus seluruh file bersama; perlindungan tugas aktif tetap berlaku di server.'
    },
    task_id: {
      label: 'ID tugas'
    },
    purge_task_button: {
      label: 'Purge tugas'
    },
    run_preview: {
      label: 'Pratinjau'
    },
    value_true: {
      label: 'true — aktif'
    },
    value_false: {
      label: 'false — nonaktif'
    }
  },
  it: {
    tab_intro: {
      description: 'Politica di conservazione del runtime in `runtime-retention.json`: soglie della manutenzione pianificata, regole di compattazione e azioni protette di pulizia manuale.'
    },
    daily_maintenance_enabled: {
      label: 'Manutenzione giornaliera',
      description: 'Attiva o disattiva la manutenzione giornaliera pianificata. Quando è abilitata, l’orchestratore può elaborare in base alla pianificazione un lotto limitato di attività idonee senza intervento manuale.'
    },
    daily_maintenance_max_tasks_per_run: {
      label: 'Numero massimo di attività per esecuzione',
      description: 'Limite superiore di quante attività idonee la manutenzione giornaliera elabora in una singola esecuzione. Riduce l’ampiezza dell’impatto se le soglie sono configurate in modo errato.'
    },
    eligible_older_than_days: {
      label: 'Età minima dell’attività (giorni)',
      description: 'Un’attività deve avere almeno questa età prima che la manutenzione o la pulizia manuale possano toccare i suoi artefatti di runtime. Le attività attive e più recenti restano protette.'
    },
    keep_latest_tasks: {
      label: 'Mantieni le attività più recenti (numero)',
      description: 'Conserva sempre almeno questo numero di attività più recenti anche se sono più vecchie della soglia di età. Imposta 0 per affidarti solo all’età e alla protezione delle attività attive.'
    },
    daily_maintenance_dry_run: {
      label: 'Dry-run della manutenzione giornaliera',
      description: 'Quando è true, la manutenzione giornaliera pianificata elenca solo i candidati e scrive l’output di audit; non elimina né comprime artefatti. Usa true mentre regoli le soglie, poi passa a false per applicare.'
    },
    purge_require_confirm: {
      label: 'Conferma obbligatoria per la purge',
      description: 'Quando è true, i comandi distruttivi di purge e cleanup richiedono una frase di conferma digitata esplicitamente prima che il server li esegua.'
    },
    healthy_done_compact_after_days: {
      label: 'Compatta i DONE sani dopo (giorni)',
      description: 'Dopo questo numero di giorni, le attività completate con successo (DONE) possono essere compattate in una cronologia solo ledger una volta verificata l’evidenza del ledger.'
    },
    problem_tasks_compress_after_days: {
      label: 'Comprimi le attività problematiche dopo (giorni)',
      description: 'Dopo questo numero di giorni, gli artefatti forensi pesanti delle attività fallite o bloccate possono essere compressi mantenendo comunque evidenze leggibili per il recupero.'
    },
    manual_runtime_cleanup: {
      label: 'Pulizia manuale del runtime',
      description: 'Esegue `garda cleanup` una volta con i valori di età e mantieni-le-più-recenti delle righe sopra. L’anteprima mostra solo i candidati; Applica elimina o comprime secondo la politica e richiede conferma.'
    },
    task_purge: {
      label: 'Purge dell’attività',
      description: 'Elimina gli artefatti di runtime appartenenti a un singolo ID attività e ripara gli indici condivisi. Non rimuove interi file condivisi; la protezione delle attività attive continua ad applicarsi sul server.'
    },
    task_id: {
      label: 'ID attività'
    },
    purge_task_button: {
      label: 'Purge attività'
    },
    run_preview: {
      label: 'Anteprima'
    },
    value_true: {
      label: 'true — abilitato'
    },
    value_false: {
      label: 'false — disabilitato'
    }
  },
  ja: {
    tab_intro: {
      description: '`runtime-retention.json` にある runtime 保持ポリシーです。定期メンテナンスのしきい値、圧縮ルール、保護付きの手動クリーンアップ操作を定義します。'
    },
    daily_maintenance_enabled: {
      label: '日次メンテナンス',
      description: '定期的な日次メンテナンスを有効または無効にします。有効な場合、オーケストレーターは手動介入なしで、スケジュールに従って適格なタスクを限定数だけ処理できます。'
    },
    daily_maintenance_max_tasks_per_run: {
      label: '1 回のメンテナンスで処理する最大タスク数',
      description: '日次メンテナンスが 1 回の実行で処理する適格タスク数の上限です。しきい値設定を誤った場合の影響範囲を抑えます。'
    },
    eligible_older_than_days: {
      label: 'タスクの最小経過日数',
      description: 'メンテナンスまたは手動クリーンアップがその runtime アーティファクトに触れる前に、タスクは少なくともこの日数だけ経過している必要があります。アクティブなタスクと新しいタスクは保護されます。'
    },
    keep_latest_tasks: {
      label: '最新タスクを保持する数',
      description: '経過日数のしきい値を超えていても、少なくともこの数の最新タスクを常に保持します。経過日数とアクティブタスク保護のみに依存する場合は 0 を設定します。'
    },
    daily_maintenance_dry_run: {
      label: '日次メンテナンスの dry-run',
      description: 'true の場合、定期日次メンテナンスは候補を列挙して監査出力を書くだけで、アーティファクトの削除や圧縮は行いません。しきい値調整中は true を使い、適用時に false に切り替えてください。'
    },
    purge_require_confirm: {
      label: 'Purge に確認を必須化',
      description: 'true の場合、破壊的な purge および cleanup コマンドをサーバーが実行する前に、明示的に入力した確認フレーズが必要です。'
    },
    healthy_done_compact_after_days: {
      label: '正常な DONE を圧縮するまでの日数',
      description: 'この日数を過ぎると、正常に完了したタスク (DONE) は ledger 証跡の検証後に ledger のみの履歴へ圧縮できます。'
    },
    problem_tasks_compress_after_days: {
      label: '問題タスクを圧縮するまでの日数',
      description: 'この日数を過ぎると、失敗または停止したタスクの大きなフォレンジックアーティファクトを、復旧時に読める証跡を残したまま圧縮できます。'
    },
    manual_runtime_cleanup: {
      label: '手動 runtime クリーンアップ',
      description: '上の行の経過日数と最新保持数を使って `garda cleanup` を 1 回実行します。プレビューは候補のみを表示し、適用ではポリシーに従って削除または圧縮を行い、確認が必要です。'
    },
    task_purge: {
      label: 'タスク purge',
      description: '1 つのタスク ID に属する runtime アーティファクトを削除し、共有インデックスを修復します。共有ファイル全体は削除せず、アクティブタスク保護はサーバー側で引き続き適用されます。'
    },
    task_id: {
      label: 'タスク ID'
    },
    purge_task_button: {
      label: 'タスクを purge'
    },
    run_preview: {
      label: 'プレビュー'
    },
    value_true: {
      label: 'true — 有効'
    },
    value_false: {
      label: 'false — 無効'
    }
  },
  ko: {
    tab_intro: {
      description: '`runtime-retention.json`에 있는 runtime 보존 정책입니다. 예약된 유지보수 임계값, 압축 규칙, 보호된 수동 정리 작업을 정의합니다.'
    },
    daily_maintenance_enabled: {
      label: '일일 유지보수',
      description: '예약된 일일 유지보수를 켜거나 끕니다. 활성화되면 오케스트레이터가 수동 개입 없이 일정에 따라 제한된 수의 적격 작업을 처리할 수 있습니다.'
    },
    daily_maintenance_max_tasks_per_run: {
      label: '유지보수 1회당 최대 작업 수',
      description: '일일 유지보수가 한 번 실행될 때 처리할 적격 작업 수의 상한입니다. 임계값이 잘못 구성되었을 때 영향 범위를 제한합니다.'
    },
    eligible_older_than_days: {
      label: '작업 최소 경과 일수',
      description: '유지보수나 수동 정리가 작업의 runtime 아티팩트를 건드리려면 해당 작업이 최소 이 일수만큼 오래되어야 합니다. 활성 작업과 더 최근 작업은 보호됩니다.'
    },
    keep_latest_tasks: {
      label: '최신 작업 유지 수',
      description: '나이 임계값을 넘었더라도 최소한 이 수만큼의 최신 작업은 항상 보존합니다. 나이와 활성 작업 보호만 사용하려면 0으로 설정하세요.'
    },
    daily_maintenance_dry_run: {
      label: '일일 유지보수 dry-run',
      description: '값이 true이면 예약된 일일 유지보수는 후보만 나열하고 감사 출력을 기록하며, 아티팩트를 삭제하거나 압축하지 않습니다. 임계값을 조정하는 동안 true를 사용하고, 적용할 때 false로 바꾸세요.'
    },
    purge_require_confirm: {
      label: 'Purge 확인 필수',
      description: '값이 true이면 파괴적인 purge 및 cleanup 명령을 서버가 실행하기 전에 명시적으로 입력한 확인 문구가 필요합니다.'
    },
    healthy_done_compact_after_days: {
      label: '정상 DONE 압축 시점 (일)',
      description: '이 일수가 지나면 성공적으로 완료된 작업(DONE)은 ledger 증거가 검증된 뒤 ledger 전용 이력으로 압축될 수 있습니다.'
    },
    problem_tasks_compress_after_days: {
      label: '문제 작업 압축 시점 (일)',
      description: '이 일수가 지나면 실패했거나 멈춘 작업의 큰 포렌식 아티팩트를, 복구용으로 읽을 수 있는 증거를 유지한 채 압축할 수 있습니다.'
    },
    manual_runtime_cleanup: {
      label: '수동 runtime 정리',
      description: '위 행의 경과일 및 최신 보존 값을 사용해 `garda cleanup`을 한 번 실행합니다. 미리보기는 후보만 보여 주고, 적용은 정책에 따라 삭제 또는 압축을 수행하며 확인이 필요합니다.'
    },
    task_purge: {
      label: '작업 purge',
      description: '하나의 작업 ID가 소유한 runtime 아티팩트를 삭제하고 공유 인덱스를 복구합니다. 전체 공유 파일은 삭제하지 않으며, 활성 작업 보호는 서버에서 계속 적용됩니다.'
    },
    task_id: {
      label: '작업 ID'
    },
    purge_task_button: {
      label: '작업 purge'
    },
    run_preview: {
      label: '미리보기'
    },
    value_true: {
      label: 'true — 활성화'
    },
    value_false: {
      label: 'false — 비활성화'
    }
  },
  nl: {
    tab_intro: {
      description: 'Retentiebeleid voor runtime in `runtime-retention.json`: drempels voor geplande onderhoudstaken, compactieregels en beschermde handmatige opschoningsacties.'
    },
    daily_maintenance_enabled: {
      label: 'Dagelijks onderhoud',
      description: 'Schakelt gepland dagelijks onderhoud in of uit. Wanneer ingeschakeld kan de orchestrator volgens schema een beperkte batch geschikte taken verwerken zonder handmatige tussenkomst.'
    },
    daily_maintenance_max_tasks_per_run: {
      label: 'Maximaal aantal taken per onderhoudsrun',
      description: 'Bovengrens voor hoeveel geschikte taken het dagelijkse onderhoud in één run verwerkt. Beperkt de impact als drempels verkeerd zijn geconfigureerd.'
    },
    eligible_older_than_days: {
      label: 'Minimale taakleeftijd (dagen)',
      description: 'Een taak moet minstens zo oud zijn voordat onderhoud of handmatige opschoning de runtime-artefacten ervan mag aanraken. Actieve en recentere taken blijven beschermd.'
    },
    keep_latest_tasks: {
      label: 'Nieuwste taken behouden (aantal)',
      description: 'Behoud altijd minstens zoveel van de meest recente taken, ook als ze ouder zijn dan de leeftijdsdrempel. Stel 0 in om alleen op leeftijd en bescherming van actieve taken te vertrouwen.'
    },
    daily_maintenance_dry_run: {
      label: 'Dry-run voor dagelijks onderhoud',
      description: 'Wanneer de waarde true is, somt het geplande dagelijkse onderhoud alleen kandidaten op en schrijft het audituitvoer; artefacten worden niet verwijderd of gecomprimeerd. Gebruik true tijdens het afstellen van drempels en zet daarna false om toe te passen.'
    },
    purge_require_confirm: {
      label: 'Bevestiging voor purge vereist',
      description: 'Wanneer de waarde true is, vereisen destructieve purge- en cleanup-opdrachten een expliciet getypte bevestigingszin voordat de server ze uitvoert.'
    },
    healthy_done_compact_after_days: {
      label: 'Gezonde DONE comprimeren na (dagen)',
      description: 'Na zoveel dagen mogen succesvol voltooide taken (DONE) worden gecompacteerd tot alleen ledger-geschiedenis zodra het ledger-bewijs is geverifieerd.'
    },
    problem_tasks_compress_after_days: {
      label: 'Probleemtaken comprimeren na (dagen)',
      description: 'Na zoveel dagen mogen zware forensische artefacten van mislukte of vastgelopen taken worden gecomprimeerd, terwijl herstelbare leesbare bewijzen behouden blijven.'
    },
    manual_runtime_cleanup: {
      label: 'Handmatige runtime-opruiming',
      description: 'Voert `garda cleanup` één keer uit met de waarden voor leeftijd en nieuwste-behouden uit de regels hierboven. Voorbeeld toont alleen kandidaten; Toepassen verwijdert of comprimeert volgens het beleid en vereist bevestiging.'
    },
    task_purge: {
      label: 'Taak-purge',
      description: 'Verwijdert runtime-artefacten die eigendom zijn van één taak-ID en herstelt gedeelde indexen. Verwijdert geen volledige gedeelde bestanden; bescherming van actieve taken blijft op de server van kracht.'
    },
    task_id: {
      label: 'Taak-ID'
    },
    purge_task_button: {
      label: 'Taak purgen'
    },
    run_preview: {
      label: 'Voorbeeld'
    },
    value_true: {
      label: 'true — ingeschakeld'
    },
    value_false: {
      label: 'false — uitgeschakeld'
    }
  },
  pl: {
    tab_intro: {
      description: 'Polityka retencji runtime w `runtime-retention.json`: progi zaplanowanej konserwacji, reguły kompaktowania i chronione ręczne akcje czyszczenia.'
    },
    daily_maintenance_enabled: {
      label: 'Codzienna konserwacja',
      description: 'Włącza lub wyłącza zaplanowaną codzienną konserwację. Gdy jest włączona, orkiestrator może według harmonogramu przetwarzać ograniczoną partię kwalifikujących się zadań bez ręcznej interwencji.'
    },
    daily_maintenance_max_tasks_per_run: {
      label: 'Maksymalna liczba zadań na jedno uruchomienie',
      description: 'Górny limit liczby kwalifikujących się zadań przetwarzanych przez codzienną konserwację w jednym przebiegu. Ogranicza skalę skutków, jeśli progi są źle skonfigurowane.'
    },
    eligible_older_than_days: {
      label: 'Minimalny wiek zadania (dni)',
      description: 'Zadanie musi mieć co najmniej tyle dni, zanim konserwacja lub ręczne czyszczenie będą mogły dotknąć jego artefaktów runtime. Aktywne i nowsze zadania pozostają chronione.'
    },
    keep_latest_tasks: {
      label: 'Zachowaj najnowsze zadania (liczba)',
      description: 'Zawsze zachowuje co najmniej tyle najnowszych zadań, nawet jeśli są starsze niż próg wieku. Ustaw 0, aby polegać wyłącznie na wieku i ochronie aktywnych zadań.'
    },
    daily_maintenance_dry_run: {
      label: 'Dry-run codziennej konserwacji',
      description: 'Gdy wartość to true, zaplanowana codzienna konserwacja tylko wypisuje kandydatów i zapisuje dane audytowe; nie usuwa ani nie kompresuje artefaktów. Użyj true podczas strojenia progów, a potem przełącz na false, aby zastosować.'
    },
    purge_require_confirm: {
      label: 'Wymagaj potwierdzenia purge',
      description: 'Gdy wartość to true, destrukcyjne polecenia purge i cleanup wymagają jawnie wpisanej frazy potwierdzającej, zanim serwer je wykona.'
    },
    healthy_done_compact_after_days: {
      label: 'Kompaktuj zdrowe DONE po (dniach)',
      description: 'Po tylu dniach pomyślnie zakończone zadania (DONE) mogą zostać skompaktowane do historii tylko w ledgerze, gdy dowód ledgera zostanie zweryfikowany.'
    },
    problem_tasks_compress_after_days: {
      label: 'Kompresuj problematyczne zadania po (dniach)',
      description: 'Po tylu dniach ciężkie artefakty śledcze zadań nieudanych lub zablokowanych mogą zostać skompresowane przy zachowaniu czytelnych dowodów potrzebnych do odzyskiwania.'
    },
    manual_runtime_cleanup: {
      label: 'Ręczne czyszczenie runtime',
      description: 'Uruchamia `garda cleanup` jeden raz z wartościami wieku i liczby najnowszych zadań z wierszy powyżej. Podgląd pokazuje tylko kandydatów; Zastosuj usuwa lub kompresuje zgodnie z polityką i wymaga potwierdzenia.'
    },
    task_purge: {
      label: 'Purge zadania',
      description: 'Usuwa artefakty runtime należące do jednego identyfikatora zadania i naprawia współdzielone indeksy. Nie usuwa całych współdzielonych plików; ochrona aktywnych zadań nadal obowiązuje po stronie serwera.'
    },
    task_id: {
      label: 'ID zadania'
    },
    purge_task_button: {
      label: 'Wyczyść zadanie'
    },
    run_preview: {
      label: 'Podgląd'
    },
    value_true: {
      label: 'true — włączone'
    },
    value_false: {
      label: 'false — wyłączone'
    }
  },
  pt: {
    tab_intro: {
      description: 'Política de retenção de runtime em `runtime-retention.json`: limites de manutenção agendada, regras de compactação e ações protegidas de limpeza manual.'
    },
    daily_maintenance_enabled: {
      label: 'Manutenção diária',
      description: 'Ativa ou desativa a manutenção diária agendada. Quando está ativada, o orquestrador pode processar, de acordo com o agendamento, um lote limitado de tarefas elegíveis sem intervenção manual.'
    },
    daily_maintenance_max_tasks_per_run: {
      label: 'Máximo de tarefas por execução de manutenção',
      description: 'Limite superior de quantas tarefas elegíveis a manutenção diária processa numa única execução. Reduz o alcance do impacto se os limites estiverem configurados incorretamente.'
    },
    eligible_older_than_days: {
      label: 'Idade mínima da tarefa (dias)',
      description: 'Uma tarefa tem de ter pelo menos esta idade antes que a manutenção ou a limpeza manual possam tocar nos seus artefactos de runtime. Tarefas ativas e mais recentes permanecem protegidas.'
    },
    keep_latest_tasks: {
      label: 'Manter as tarefas mais recentes (quantidade)',
      description: 'Preserva sempre pelo menos esta quantidade de tarefas mais recentes, mesmo que sejam mais antigas do que o limite de idade. Defina 0 para depender apenas da idade e da proteção de tarefas ativas.'
    },
    daily_maintenance_dry_run: {
      label: 'Dry-run da manutenção diária',
      description: 'Quando está em true, a manutenção diária agendada apenas lista candidatos e grava saída de auditoria; não elimina nem comprime artefactos. Use true enquanto ajusta os limites e depois mude para false para aplicar.'
    },
    purge_require_confirm: {
      label: 'Confirmação obrigatória para purge',
      description: 'Quando está em true, os comandos destrutivos de purge e cleanup exigem uma frase de confirmação escrita explicitamente antes de o servidor os executar.'
    },
    healthy_done_compact_after_days: {
      label: 'Compactar DONE saudáveis após (dias)',
      description: 'Após este número de dias, tarefas concluídas com sucesso (DONE) podem ser compactadas para um histórico apenas de ledger, depois de a evidência do ledger ser verificada.'
    },
    problem_tasks_compress_after_days: {
      label: 'Comprimir tarefas problemáticas após (dias)',
      description: 'Após este número de dias, artefactos forenses pesados de tarefas com falha ou bloqueadas podem ser comprimidos, mantendo evidência legível para recuperação.'
    },
    manual_runtime_cleanup: {
      label: 'Limpeza manual de runtime',
      description: 'Executa `garda cleanup` uma vez com os valores de idade e manter-mais-recentes das linhas acima. A pré-visualização mostra apenas candidatos; Aplicar elimina ou comprime de acordo com a política e requer confirmação.'
    },
    task_purge: {
      label: 'Purge de tarefa',
      description: 'Elimina artefactos de runtime pertencentes a um único ID de tarefa e repara índices partilhados. Não remove ficheiros partilhados inteiros; a proteção de tarefas ativas continua a aplicar-se no servidor.'
    },
    task_id: {
      label: 'ID da tarefa'
    },
    purge_task_button: {
      label: 'Purge da tarefa'
    },
    run_preview: {
      label: 'Pré-visualização'
    },
    value_true: {
      label: 'true — ativado'
    },
    value_false: {
      label: 'false — desativado'
    }
  },
  'pt-BR': {
    tab_intro: {
      description: 'Política de retenção de runtime em `runtime-retention.json`: limites da manutenção agendada, regras de compactação e ações protegidas de limpeza manual.'
    },
    daily_maintenance_enabled: {
      label: 'Manutenção diária',
      description: 'Ativa ou desativa a manutenção diária agendada. Quando está ativada, o orquestrador pode processar, conforme o agendamento, um lote limitado de tarefas elegíveis sem intervenção manual.'
    },
    daily_maintenance_max_tasks_per_run: {
      label: 'Máximo de tarefas por execução de manutenção',
      description: 'Limite superior de quantas tarefas elegíveis a manutenção diária processa em uma única execução. Reduz o alcance do impacto se os limites estiverem configurados incorretamente.'
    },
    eligible_older_than_days: {
      label: 'Idade mínima da tarefa (dias)',
      description: 'Uma tarefa precisa ter pelo menos essa idade antes que a manutenção ou a limpeza manual possam tocar em seus artefatos de runtime. Tarefas ativas e mais recentes permanecem protegidas.'
    },
    keep_latest_tasks: {
      label: 'Manter as tarefas mais recentes (quantidade)',
      description: 'Sempre preserva pelo menos essa quantidade das tarefas mais recentes, mesmo que sejam mais antigas que o limite de idade. Defina 0 para depender apenas da idade e da proteção das tarefas ativas.'
    },
    daily_maintenance_dry_run: {
      label: 'Dry-run da manutenção diária',
      description: 'Quando está em true, a manutenção diária agendada apenas lista candidatos e grava saída de auditoria; não exclui nem comprime artefatos. Use true enquanto ajusta os limites e depois mude para false para aplicar.'
    },
    purge_require_confirm: {
      label: 'Confirmação obrigatória para purge',
      description: 'Quando está em true, os comandos destrutivos de purge e cleanup exigem uma frase de confirmação digitada explicitamente antes de o servidor executá-los.'
    },
    healthy_done_compact_after_days: {
      label: 'Compactar DONE saudáveis após (dias)',
      description: 'Depois desse número de dias, tarefas concluídas com sucesso (DONE) podem ser compactadas para um histórico apenas de ledger, depois que a evidência do ledger for verificada.'
    },
    problem_tasks_compress_after_days: {
      label: 'Comprimir tarefas problemáticas após (dias)',
      description: 'Depois desse número de dias, artefatos forenses pesados de tarefas com falha ou travadas podem ser comprimidos, mantendo evidência legível para recuperação.'
    },
    manual_runtime_cleanup: {
      label: 'Limpeza manual de runtime',
      description: 'Executa `garda cleanup` uma vez com os valores de idade e manter-mais-recentes das linhas acima. A prévia mostra apenas candidatos; Aplicar exclui ou comprime de acordo com a política e exige confirmação.'
    },
    task_purge: {
      label: 'Purge de tarefa',
      description: 'Exclui artefatos de runtime pertencentes a um único ID de tarefa e repara índices compartilhados. Não remove arquivos compartilhados inteiros; a proteção de tarefas ativas continua valendo no servidor.'
    },
    task_id: {
      label: 'ID da tarefa'
    },
    purge_task_button: {
      label: 'Purge da tarefa'
    },
    run_preview: {
      label: 'Prévia'
    },
    value_true: {
      label: 'true — ativado'
    },
    value_false: {
      label: 'false — desativado'
    }
  },
  ru: {
    tab_intro: {
      description: 'Политика хранения runtime в `runtime-retention.json`: пороги планового обслуживания, правила компактирования и защищённые действия ручной очистки.'
    },
    daily_maintenance_enabled: {
      label: 'Ежедневное обслуживание',
      description: 'Включает или отключает плановое ежедневное обслуживание. Когда параметр включён, оркестратор может по расписанию обрабатывать ограниченную пачку подходящих задач без ручного вмешательства.'
    },
    daily_maintenance_max_tasks_per_run: {
      label: 'Максимум задач за один проход обслуживания',
      description: 'Верхняя граница того, сколько подходящих задач ежедневное обслуживание обрабатывает за один запуск. Ограничивает радиус воздействия, если пороги настроены неверно.'
    },
    eligible_older_than_days: {
      label: 'Минимальный возраст задачи (дней)',
      description: 'Задача должна быть не моложе этого числа дней, прежде чем обслуживание или ручная очистка смогут затронуть её runtime-артефакты. Активные и более новые задачи остаются защищёнными.'
    },
    keep_latest_tasks: {
      label: 'Сохранять новейшие задачи (количество)',
      description: 'Всегда сохраняет как минимум столько самых новых задач, даже если они старше возрастного порога. Установите 0, чтобы полагаться только на возраст и защиту активных задач.'
    },
    daily_maintenance_dry_run: {
      label: 'Пробный запуск ежедневного обслуживания',
      description: 'Когда значение равно true, плановое ежедневное обслуживание только перечисляет кандидатов и пишет аудит-вывод; оно не удаляет и не сжимает артефакты. Используйте true при настройке порогов, затем переключите на false для применения.'
    },
    purge_require_confirm: {
      label: 'Требовать подтверждение для purge',
      description: 'Когда значение равно true, разрушительные команды purge и cleanup требуют явно введённую фразу подтверждения, прежде чем сервер их выполнит.'
    },
    healthy_done_compact_after_days: {
      label: 'Компактировать здоровые DONE после (дней)',
      description: 'Через столько дней успешно завершённые задачи (DONE) можно компактировать до истории только в ledger после проверки ledger-доказательств.'
    },
    problem_tasks_compress_after_days: {
      label: 'Сжимать проблемные задачи после (дней)',
      description: 'Через столько дней тяжёлые forensic-артефакты задач с ошибкой или зависших задач можно сжимать, сохраняя читаемые доказательства для восстановления.'
    },
    manual_runtime_cleanup: {
      label: 'Ручная очистка runtime',
      description: 'Запускает `garda cleanup` один раз с возрастом и значением keep-latest из строк выше. Preview показывает только кандидатов; Apply удаляет или сжимает по политике и требует подтверждения.'
    },
    task_purge: {
      label: 'Purge задачи',
      description: 'Удаляет runtime-артефакты, принадлежащие одному ID задачи, и восстанавливает общие индексы. Не удаляет целиком общие файлы; защита активных задач на сервере сохраняется.'
    },
    task_id: {
      label: 'ID задачи'
    },
    purge_task_button: {
      label: 'Purge задачи'
    },
    run_preview: {
      label: 'Предпросмотр'
    },
    value_true: {
      label: 'true — включено'
    },
    value_false: {
      label: 'false — выключено'
    }
  },
  sv: {
    tab_intro: {
      description: 'Retentionspolicy för runtime i `runtime-retention.json`: trösklar för schemalagt underhåll, regler för kompaktering och skyddade manuella rensningsåtgärder.'
    },
    daily_maintenance_enabled: {
      label: 'Dagligt underhåll',
      description: 'Slår på eller av schemalagt dagligt underhåll. När det är aktiverat kan orkestreraren enligt schema behandla en begränsad mängd kvalificerade uppgifter utan manuell inblandning.'
    },
    daily_maintenance_max_tasks_per_run: {
      label: 'Max antal uppgifter per underhållskörning',
      description: 'Övre gräns för hur många kvalificerade uppgifter det dagliga underhållet behandlar i en enda körning. Begränsar påverkan om tröskelvärdena är felkonfigurerade.'
    },
    eligible_older_than_days: {
      label: 'Minsta uppgiftsålder (dagar)',
      description: 'En uppgift måste vara minst så här gammal innan underhåll eller manuell rensning får röra dess runtime-artefakter. Aktiva och nyare uppgifter förblir skyddade.'
    },
    keep_latest_tasks: {
      label: 'Behåll de senaste uppgifterna (antal)',
      description: 'Bevarar alltid minst så många av de senaste uppgifterna även om de är äldre än ålderströskeln. Sätt 0 för att bara förlita dig på ålder och skydd för aktiva uppgifter.'
    },
    daily_maintenance_dry_run: {
      label: 'Dry-run för dagligt underhåll',
      description: 'När värdet är true listar det schemalagda dagliga underhållet bara kandidater och skriver granskningsutdata; det tar inte bort eller komprimerar artefakter. Använd true medan du justerar trösklarna och byt sedan till false för att tillämpa.'
    },
    purge_require_confirm: {
      label: 'Kräv bekräftelse för purge',
      description: 'När värdet är true kräver destruktiva purge- och cleanup-kommandon en uttryckligen inskriven bekräftelsefras innan servern kör dem.'
    },
    healthy_done_compact_after_days: {
      label: 'Kompaktera friska DONE efter (dagar)',
      description: 'Efter så många dagar kan framgångsrikt slutförda uppgifter (DONE) kompakteras till endast ledger-historik när ledger-bevisen har verifierats.'
    },
    problem_tasks_compress_after_days: {
      label: 'Komprimera problemuppgifter efter (dagar)',
      description: 'Efter så många dagar kan tunga forensiska artefakter från misslyckade eller fastnade uppgifter komprimeras samtidigt som läsbara återställningsbevis bevaras.'
    },
    manual_runtime_cleanup: {
      label: 'Manuell runtime-rensning',
      description: 'Kör `garda cleanup` en gång med ålders- och behåll-senaste-värdena från raderna ovan. Förhandsvisning visar bara kandidater; Verkställ tar bort eller komprimerar enligt policyn och kräver bekräftelse.'
    },
    task_purge: {
      label: 'Uppgifts-purge',
      description: 'Tar bort runtime-artefakter som ägs av ett enda uppgifts-ID och reparerar delade index. Tar inte bort hela delade filer; skydd för aktiva uppgifter gäller fortfarande på servern.'
    },
    task_id: {
      label: 'Uppgifts-ID'
    },
    purge_task_button: {
      label: 'Rensa uppgift'
    },
    run_preview: {
      label: 'Förhandsvisning'
    },
    value_true: {
      label: 'true — aktiverad'
    },
    value_false: {
      label: 'false — inaktiverad'
    }
  },
  tr: {
    tab_intro: {
      description: '`runtime-retention.json` içindeki runtime saklama politikası: zamanlanmış bakım eşikleri, sıkıştırma kuralları ve korumalı manuel temizlik işlemleri.'
    },
    daily_maintenance_enabled: {
      label: 'Günlük bakım',
      description: 'Zamanlanmış günlük bakımı açar veya kapatır. Etkinleştirildiğinde orkestratör, manuel müdahale olmadan programa göre sınırlı sayıda uygun görevi işleyebilir.'
    },
    daily_maintenance_max_tasks_per_run: {
      label: 'Bakım çalıştırması başına en fazla görev',
      description: 'Günlük bakımın tek bir çalıştırmada işleyeceği uygun görev sayısının üst sınırı. Eşikler yanlış yapılandırılmışsa etki alanını sınırlar.'
    },
    eligible_older_than_days: {
      label: 'Görevin asgari yaşı (gün)',
      description: 'Bakım veya manuel temizlik bir görevin runtime artefaktlarına dokunmadan önce görev en az bu kadar günlük olmalıdır. Etkin ve daha yeni görevler korunur.'
    },
    keep_latest_tasks: {
      label: 'En yeni görevleri koru (adet)',
      description: 'Yaş eşiğini aşsalar bile en az bu sayıdaki en yeni görevi her zaman korur. Yalnızca yaşa ve etkin görev korumasına güvenmek için 0 ayarlayın.'
    },
    daily_maintenance_dry_run: {
      label: 'Günlük bakım dry-run',
      description: 'Değer true olduğunda zamanlanmış günlük bakım yalnızca adayları listeler ve denetim çıktısı yazar; artefaktları silmez veya sıkıştırmaz. Eşikleri ayarlarken true kullanın, uygulamak için sonra false yapın.'
    },
    purge_require_confirm: {
      label: 'Purge için onay zorunlu',
      description: 'Değer true olduğunda yıkıcı purge ve cleanup komutları, sunucu bunları çalıştırmadan önce açıkça yazılmış bir onay ifadesi gerektirir.'
    },
    healthy_done_compact_after_days: {
      label: 'Sağlıklı DONE görevlerini şu kadar gün sonra sıkıştır',
      description: 'Bu kadar gün sonra başarıyla tamamlanan görevler (DONE), ledger kanıtı doğrulandıktan sonra yalnızca ledger geçmişine sıkıştırılabilir.'
    },
    problem_tasks_compress_after_days: {
      label: 'Sorunlu görevleri şu kadar gün sonra sıkıştır',
      description: 'Bu kadar gün sonra başarısız veya takılı kalmış görevlerin ağır adli artefaktları, kurtarma için okunabilir kanıt korunarak sıkıştırılabilir.'
    },
    manual_runtime_cleanup: {
      label: 'Manuel runtime temizliği',
      description: 'Yukarıdaki satırlardaki yaş ve en-yenileri-koru değerleriyle `garda cleanup` komutunu bir kez çalıştırır. Önizleme yalnızca adayları gösterir; Uygula politikaya göre siler veya sıkıştırır ve onay ister.'
    },
    task_purge: {
      label: 'Görev purge',
      description: 'Tek bir görev kimliğine ait runtime artefaktlarını siler ve paylaşılan dizinleri onarır. Tüm paylaşılan dosyaları kaldırmaz; etkin görev koruması sunucuda geçerli olmaya devam eder.'
    },
    task_id: {
      label: 'Görev kimliği'
    },
    purge_task_button: {
      label: 'Görevi temizle'
    },
    run_preview: {
      label: 'Önizleme'
    },
    value_true: {
      label: 'true — etkin'
    },
    value_false: {
      label: 'false — devre dışı'
    }
  },
  uk: {
    tab_intro: {
      description: 'Політика зберігання runtime у `runtime-retention.json`: пороги планового обслуговування, правила компактизації та захищені дії ручного очищення.'
    },
    daily_maintenance_enabled: {
      label: 'Щоденне обслуговування',
      description: 'Увімкнути або вимкнути заплановане щоденне обслуговування. Коли параметр увімкнено, оркестратор може за розкладом обробляти обмежену партію придатних задач без ручного втручання.'
    },
    daily_maintenance_max_tasks_per_run: {
      label: 'Максимум задач за один прохід обслуговування',
      description: 'Верхня межа того, скільки придатних задач щоденне обслуговування обробляє за один запуск. Обмежує радіус впливу, якщо пороги налаштовані неправильно.'
    },
    eligible_older_than_days: {
      label: 'Мінімальний вік задачі (днів)',
      description: 'Задача має бути щонайменше такого віку, перш ніж обслуговування або ручне очищення зможуть торкнутися її runtime-артефактів. Активні та новіші задачі залишаються захищеними.'
    },
    keep_latest_tasks: {
      label: 'Зберігати найновіші задачі (кількість)',
      description: 'Завжди зберігає щонайменше стільки найновіших задач, навіть якщо вони старші за віковий поріг. Установіть 0, щоб покладатися лише на вік і захист активних задач.'
    },
    daily_maintenance_dry_run: {
      label: 'Пробний запуск щоденного обслуговування',
      description: 'Коли значення дорівнює true, заплановане щоденне обслуговування лише перелічує кандидатів і записує аудит-вивід; воно не видаляє та не стискає артефакти. Використовуйте true під час налаштування порогів, а потім перемкніть на false для застосування.'
    },
    purge_require_confirm: {
      label: 'Вимагати підтвердження для purge',
      description: 'Коли значення дорівнює true, руйнівні команди purge і cleanup вимагають явно введену фразу підтвердження, перш ніж сервер їх виконає.'
    },
    healthy_done_compact_after_days: {
      label: 'Компактизувати здорові DONE після (днів)',
      description: 'Через стільки днів успішно завершені задачі (DONE) можна компактизувати до історії лише в ledger після перевірки ledger-доказів.'
    },
    problem_tasks_compress_after_days: {
      label: 'Стискати проблемні задачі після (днів)',
      description: 'Через стільки днів важкі forensic-артефакти задач із помилками або завислих задач можна стискати, зберігаючи читабельні докази для відновлення.'
    },
    manual_runtime_cleanup: {
      label: 'Ручне очищення runtime',
      description: 'Запускає `garda cleanup` один раз зі значеннями віку та keep-latest з рядків вище. Preview показує лише кандидатів; Apply видаляє або стискає за політикою та вимагає підтвердження.'
    },
    task_purge: {
      label: 'Purge задачі',
      description: 'Видаляє runtime-артефакти, що належать одному ID задачі, і відновлює спільні індекси. Не видаляє цілком спільні файли; захист активних задач на сервері зберігається.'
    },
    task_id: {
      label: 'ID задачі'
    },
    purge_task_button: {
      label: 'Purge задачі'
    },
    run_preview: {
      label: 'Попередній перегляд'
    },
    value_true: {
      label: 'true — увімкнено'
    },
    value_false: {
      label: 'false — вимкнено'
    }
  },
  vi: {
    tab_intro: {
      description: 'Chính sách lưu giữ runtime trong `runtime-retention.json`: ngưỡng bảo trì theo lịch, quy tắc nén gọn và các thao tác dọn dẹp thủ công có bảo vệ.'
    },
    daily_maintenance_enabled: {
      label: 'Bảo trì hằng ngày',
      description: 'Bật hoặc tắt chế độ bảo trì hằng ngày theo lịch. Khi được bật, bộ điều phối có thể xử lý theo lịch một lô giới hạn các tác vụ đủ điều kiện mà không cần can thiệp thủ công.'
    },
    daily_maintenance_max_tasks_per_run: {
      label: 'Số tác vụ tối đa mỗi lần bảo trì',
      description: 'Giới hạn trên về số tác vụ đủ điều kiện mà bảo trì hằng ngày xử lý trong một lần chạy. Giảm phạm vi ảnh hưởng nếu các ngưỡng bị cấu hình sai.'
    },
    eligible_older_than_days: {
      label: 'Tuổi tối thiểu của tác vụ (ngày)',
      description: 'Một tác vụ phải cũ ít nhất chừng này ngày trước khi bảo trì hoặc dọn dẹp thủ công được phép chạm vào các artefact runtime của nó. Các tác vụ đang hoạt động và mới hơn vẫn được bảo vệ.'
    },
    keep_latest_tasks: {
      label: 'Giữ lại các tác vụ mới nhất (số lượng)',
      description: 'Luôn giữ lại ít nhất chừng này tác vụ mới nhất ngay cả khi chúng cũ hơn ngưỡng tuổi. Đặt 0 để chỉ dựa vào tuổi và cơ chế bảo vệ tác vụ đang hoạt động.'
    },
    daily_maintenance_dry_run: {
      label: 'Dry-run bảo trì hằng ngày',
      description: 'Khi giá trị là true, bảo trì hằng ngày theo lịch chỉ liệt kê các ứng viên và ghi đầu ra kiểm toán; không xóa hoặc nén artefact nào. Dùng true khi tinh chỉnh ngưỡng, rồi chuyển sang false để áp dụng.'
    },
    purge_require_confirm: {
      label: 'Yêu cầu xác nhận khi purge',
      description: 'Khi giá trị là true, các lệnh purge và cleanup mang tính phá hủy yêu cầu một cụm xác nhận được gõ rõ ràng trước khi máy chủ thực thi.'
    },
    healthy_done_compact_after_days: {
      label: 'Nén gọn DONE lành mạnh sau (ngày)',
      description: 'Sau chừng này ngày, các tác vụ hoàn tất thành công (DONE) có thể được nén gọn thành lịch sử chỉ còn ledger sau khi bằng chứng ledger đã được xác minh.'
    },
    problem_tasks_compress_after_days: {
      label: 'Nén các tác vụ có vấn đề sau (ngày)',
      description: 'Sau chừng này ngày, các artefact điều tra lớn của các tác vụ thất bại hoặc bị kẹt có thể được nén lại, trong khi vẫn giữ bằng chứng có thể đọc được để phục hồi.'
    },
    manual_runtime_cleanup: {
      label: 'Dọn dẹp runtime thủ công',
      description: 'Chạy `garda cleanup` một lần với các giá trị tuổi và giữ-lại-mới-nhất từ các dòng phía trên. Xem trước chỉ hiển thị ứng viên; Áp dụng sẽ xóa hoặc nén theo chính sách và yêu cầu xác nhận.'
    },
    task_purge: {
      label: 'Purge tác vụ',
      description: 'Xóa các artefact runtime thuộc về một ID tác vụ và sửa các chỉ mục dùng chung. Không xóa toàn bộ các tệp dùng chung; cơ chế bảo vệ tác vụ đang hoạt động vẫn được áp dụng ở máy chủ.'
    },
    task_id: {
      label: 'ID tác vụ'
    },
    purge_task_button: {
      label: 'Purge tác vụ'
    },
    run_preview: {
      label: 'Xem trước'
    },
    value_true: {
      label: 'true — bật'
    },
    value_false: {
      label: 'false — tắt'
    }
  },
  'zh-CN': {
    tab_intro: {
      description: '`runtime-retention.json` 中的 runtime 保留策略：计划维护阈值、压缩规则以及受保护的手动清理操作。'
    },
    daily_maintenance_enabled: {
      label: '每日维护',
      description: '开启或关闭计划中的每日维护。启用后，编排器可以按计划在无需人工干预的情况下处理一批数量受限的合格任务。'
    },
    daily_maintenance_max_tasks_per_run: {
      label: '每次维护运行的最大任务数',
      description: '每日维护在单次运行中可处理的合格任务数量上限。如果阈值配置错误，它可以限制影响范围。'
    },
    eligible_older_than_days: {
      label: '任务最小保留天数',
      description: '任务至少达到这个天数后，维护或手动清理才可以触碰它的 runtime 制品。活动中的任务和较新的任务仍会受到保护。'
    },
    keep_latest_tasks: {
      label: '保留最新任务数',
      description: '即使任务已经超过年龄阈值，也始终至少保留这么多最近的任务。设置为 0 时，仅依赖年龄规则和活动任务保护。'
    },
    daily_maintenance_dry_run: {
      label: '每日维护 dry-run',
      description: '当值为 true 时，计划中的每日维护只会列出候选项并写入审计输出；不会删除或压缩任何制品。调试阈值时请使用 true，准备真正执行时再切换为 false。'
    },
    purge_require_confirm: {
      label: 'Purge 需要确认',
      description: '当值为 true 时，具有破坏性的 purge 和 cleanup 命令在服务器执行前需要明确输入确认短语。'
    },
    healthy_done_compact_after_days: {
      label: '健康 DONE 在多少天后压缩',
      description: '成功完成的任务 (DONE) 在达到这个天数后，可在 ledger 证据验证通过后压缩为仅保留 ledger 历史。'
    },
    problem_tasks_compress_after_days: {
      label: '问题任务在多少天后压缩',
      description: '失败或卡住的任务在达到这个天数后，可以压缩其较大的取证制品，同时保留可用于恢复的可读证据。'
    },
    manual_runtime_cleanup: {
      label: '手动 runtime 清理',
      description: '使用上方行中的年龄和保留最新值执行一次 `garda cleanup`。预览只显示候选项；应用会按策略删除或压缩，并要求确认。'
    },
    task_purge: {
      label: '任务 purge',
      description: '删除属于单个任务 ID 的 runtime 制品，并修复共享索引。不会删除整个共享文件；活动任务保护仍然会在服务器端生效。'
    },
    task_id: {
      label: '任务 ID'
    },
    purge_task_button: {
      label: '清理任务'
    },
    run_preview: {
      label: '预览'
    },
    value_true: {
      label: 'true — 已启用'
    },
    value_false: {
      label: 'false — 已禁用'
    }
  }
};
