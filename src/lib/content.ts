export type PieceKind = "poem" | "letter" | "fragment" | "memory";
export type PieceTone = "random" | "paper" | "ink" | "rose" | "blue" | "sage" | "clay";
export type ResolvedPieceTone = Exclude<PieceTone, "random">;
export type PieceSize = "random" | "small" | "medium" | "large";
export type PieceInteraction = "random" | "none" | "hold" | "uncover" | "turn";

export type Piece = {
  id: string;
  title: string;
  kind: PieceKind;
  date: string;
  time: string;
  collection: string;
  excerpt: string;
  body: string;
  tone: PieceTone;
  size: PieceSize;
  interaction: PieceInteraction;
  published: boolean;
  updatedAt?: { toMillis?: () => number } | null;
};

export type PieceDraft = Omit<Piece, "id" | "updatedAt">;

export type ArchiveCollection = {
  id: string;
  title: string;
  subtitle: string;
  color: string;
  updatedAt?: { toMillis?: () => number } | null;
};

export type CollectionDraft = Omit<ArchiveCollection, "id" | "updatedAt">;

export const emptyCollection: CollectionDraft = {
  title: "",
  subtitle: "",
  color: "#5d634c",
};

export const emptyPiece: PieceDraft = {
  title: "",
  kind: "poem",
  date: "Undated",
  time: "",
  collection: "",
  excerpt: "",
  body: "",
  tone: "random",
  size: "random",
  interaction: "random",
  published: false,
};

export function pieceFromDocument(id: string, data: Record<string, unknown>): Piece {
  const isKind = (value: unknown): value is PieceKind =>
    value === "poem" || value === "letter" || value === "fragment" || value === "memory";
  const isTone = (value: unknown): value is PieceTone =>
    value === "random" || value === "paper" || value === "ink" || value === "rose" || value === "blue" || value === "sage" || value === "clay";
  const isSize = (value: unknown): value is PieceSize =>
    value === "random" || value === "small" || value === "medium" || value === "large";
  const isInteraction = (value: unknown): value is PieceInteraction =>
    value === "random" || value === "none" || value === "hold" || value === "uncover" || value === "turn";
  const storedSize = data.size === "randomized" ? "random" : data.size;

  return {
    id,
    title: typeof data.title === "string" ? data.title : "Untitled",
    kind: isKind(data.kind) ? data.kind : "poem",
    date: typeof data.date === "string" ? data.date : "Undated",
    time: typeof data.time === "string" ? data.time : "",
    collection: typeof data.collection === "string" ? data.collection : "",
    excerpt: typeof data.excerpt === "string" ? data.excerpt : "",
    body: typeof data.body === "string" ? data.body : "",
    tone: isTone(data.tone) ? data.tone : "random",
    size: isSize(storedSize) ? storedSize : "random",
    interaction: isInteraction(data.interaction) ? data.interaction : "random",
    published: data.published === true,
    updatedAt: typeof data.updatedAt === "object" ? (data.updatedAt as Piece["updatedAt"]) : null,
  };
}

const resolvedPieceTones: ResolvedPieceTone[] = ["paper", "ink", "rose", "blue", "sage", "clay"];

export function resolvePieceTone(tone: PieceTone, id: string): ResolvedPieceTone {
  if (tone !== "random") return tone;
  const seed = Array.from(id).reduce((total, character) => total + character.charCodeAt(0), 0);
  return resolvedPieceTones[seed % resolvedPieceTones.length];
}

export function collectionFromDocument(id: string, data: Record<string, unknown>): ArchiveCollection {
  return {
    id,
    title: typeof data.title === "string" ? data.title : "Untitled collection",
    subtitle: typeof data.subtitle === "string" ? data.subtitle : "",
    color: typeof data.color === "string" ? data.color : "#5d634c",
    updatedAt: typeof data.updatedAt === "object" ? (data.updatedAt as ArchiveCollection["updatedAt"]) : null,
  };
}

export function sortPieces(pieces: Piece[]) {
  return [...pieces].sort((left, right) => {
    const rightTime = right.updatedAt?.toMillis?.() ?? 0;
    const leftTime = left.updatedAt?.toMillis?.() ?? 0;
    return rightTime - leftTime || left.title.localeCompare(right.title);
  });
}

export function sortCollections(collections: ArchiveCollection[]) {
  return [...collections].sort((left, right) => left.title.localeCompare(right.title));
}
