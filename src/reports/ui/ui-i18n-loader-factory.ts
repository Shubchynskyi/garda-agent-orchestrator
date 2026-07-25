import type { LocalUiLocalizedText } from './ui-language-pack-loader';

export type LocalUiTranslationPack = Readonly<Record<string, LocalUiLocalizedText>>;
export type LocalUiTranslationPacks = Readonly<Record<string, LocalUiTranslationPack>>;

export function createLocalUiTranslationLoader(
    translationPacks: LocalUiTranslationPacks
): () => LocalUiTranslationPacks {
    for (const pack of Object.values(translationPacks)) {
        Object.freeze(pack);
    }

    const frozenTranslationPacks = Object.freeze(translationPacks);
    return () => frozenTranslationPacks;
}
