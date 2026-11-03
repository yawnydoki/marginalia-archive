"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { collection, doc, onSnapshot, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import styles from "./page.module.css";
import {
  collectionFromDocument,
  pieceFromDocument,
  resolvePieceTone,
  sortCollections,
  sortPieces,
  type ArchiveCollection,
  type Piece,
} from "@/lib/content";
import { getFirebaseServices, isFirebaseConfigured } from "@/lib/firebase";

type TimeMood = "morning" | "day" | "dusk" | "night" | "afterMidnight";
type WallInteraction = "none" | "hold" | "uncover" | "turn";
type RitualDemoState = "idle" | "holding" | "prepared" | "opened";

const VISITED_STORAGE_KEY = "marginalia.visited";
const REACHED_STORAGE_KEY = "marginalia.reached";
const VISITOR_STORAGE_KEY = "marginalia.visitor";
const TEST_COLLECTION_ID = "__test_interactions";

const developmentTestCollection: ArchiveCollection | null = process.env.NODE_ENV === "development" ? {
  id: TEST_COLLECTION_ID,
  title: "Interaction studies",
  subtitle: "Local previews only",
  color: "#695b4d",
} : null;

const developmentTestPieces: Piece[] = process.env.NODE_ENV === "development" ? [
  {
    id: "__test_normal",
    title: "The quiet card",
    kind: "fragment",
    date: "Local preview",
    time: "",
    collection: TEST_COLLECTION_ID,
    excerpt: "One gesture. Nothing stands between the visitor and the page.",
    body: "This is the normal opening.\n\nOne click carries the visitor directly into the reader.",
    tone: "paper",
    size: "medium",
    interaction: "none",
    published: true,
  },
  {
    id: "__test_hold",
    title: "Held long enough",
    kind: "fragment",
    date: "Local preview",
    time: "",
    collection: TEST_COLLECTION_ID,
    excerpt: "Some pages ask for a moment of pressure before they give way.",
    body: "This page opens only after a deliberate hold.\n\nRelease too soon and it remains where it was.",
    tone: "sage",
    size: "medium",
    interaction: "hold",
    published: true,
  },
  {
    id: "__test_uncover",
    title: "Under the seal",
    kind: "fragment",
    date: "Local preview",
    time: "",
    collection: TEST_COLLECTION_ID,
    excerpt: "A folded surface, a small seal, and something kept underneath.",
    body: "The first gesture breaks the seal.\n\nThe second opens what it was protecting.",
    tone: "rose",
    size: "large",
    interaction: "uncover",
    published: true,
  },
  {
    id: "__test_turn",
    title: "On the reverse",
    kind: "fragment",
    date: "Local preview",
    time: "",
    collection: TEST_COLLECTION_ID,
    excerpt: "The other side knows how this page should begin.",
    body: "Turn the card once to find its reverse.\n\nA second gesture opens the complete page.",
    tone: "blue",
    size: "medium",
    interaction: "turn",
    published: true,
  },
] : [];

function getStableSeed(id: string) {
  return Array.from(id).reduce((total, character) => total + character.charCodeAt(0), 0);
}

function getPresentationProfile(id: string) {
  const seed = getStableSeed(id);
  return {
    variant: seed % 6,
    tilt: ((seed % 13) - 6) * 0.18,
    grain: 0.08 + (seed % 5) * 0.025,
    size: (["small", "medium", "large"] as const)[Math.floor(seed / 3) % 3],
    interaction: (["none", "hold", "uncover", "turn"] as WallInteraction[])[seed % 4],
  };
}

function getCollectionPersonality(id: string) {
  return getStableSeed(id) % 4;
}

function readRememberedSet(key: string) {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return new Set<string>(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set<string>();
  }
}

function rememberSet(key: string, value: Set<string>) {
  window.localStorage.setItem(key, JSON.stringify([...value]));
}

export default function Home() {
  const [view, setView] = useState<"wall" | "shelf">("wall");
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [collections, setCollections] = useState<ArchiveCollection[]>([]);
  const [archiveStatus, setArchiveStatus] = useState<"loading" | "ready" | "unconfigured" | "error">(
    isFirebaseConfigured ? "loading" : "unconfigured",
  );
  const [selected, setSelected] = useState<Piece | null>(null);
  const [driftPiece, setDriftPiece] = useState<Piece | null>(null);
  const [showOpeningLab, setShowOpeningLab] = useState(false);
  const [showTestEntries, setShowTestEntries] = useState(process.env.NODE_ENV === "development");
  const [ritualDemoStates, setRitualDemoStates] = useState<Record<WallInteraction, RitualDemoState>>({
    none: "idle",
    hold: "idle",
    uncover: "idle",
    turn: "idle",
  });
  const [reachedPieces, setReachedPieces] = useState<Set<string>>(() => new Set());
  const [visitedPieces, setVisitedPieces] = useState<Set<string>>(() => new Set());
  const [preparedPieces, setPreparedPieces] = useState<Set<string>>(() => new Set());
  const [revealedPromptPieces, setRevealedPromptPieces] = useState<Set<string>>(() => new Set());
  const [holdingPieceId, setHoldingPieceId] = useState<string | null>(null);
  const [timeMood, setTimeMood] = useState<TimeMood>("day");
  const [isDraggingShelf, setIsDraggingShelf] = useState(false);
  const shelfRef = useRef<HTMLDivElement>(null);
  const shelfDrag = useRef({ active: false, moved: false, startX: 0, scrollLeft: 0 });
  const holdTimer = useRef<number | null>(null);
  const ritualHoldTimer = useRef<number | null>(null);
  const loadedArchiveData = useRef({ pieces: false, collections: false });

  useEffect(() => {
    const updateMood = () => {
      const hour = new Date().getHours();
      if (hour < 5) setTimeMood("afterMidnight");
      else if (hour < 12) setTimeMood("morning");
      else if (hour < 17) setTimeMood("day");
      else if (hour < 20) setTimeMood("dusk");
      else setTimeMood("night");
    };
    const loadRememberedState = window.requestAnimationFrame(() => {
      setVisitedPieces(readRememberedSet(VISITED_STORAGE_KEY));
      setReachedPieces(readRememberedSet(REACHED_STORAGE_KEY));
      updateMood();
    });
    const moodTimer = window.setInterval(updateMood, 60_000);
    return () => {
      window.cancelAnimationFrame(loadRememberedState);
      window.clearInterval(moodTimer);
    };
  }, []);

  useEffect(() => {
    const services = getFirebaseServices();
    if (!services) return;

    const publicPieces = query(collection(services.db, "pieces"), where("published", "==", true));
    return onSnapshot(
      publicPieces,
      (snapshot) => {
        const nextPieces = snapshot.docs.map((document) => pieceFromDocument(document.id, document.data()));
        setPieces(sortPieces(nextPieces));
        loadedArchiveData.current.pieces = true;
        if (loadedArchiveData.current.collections) setArchiveStatus("ready");
      },
      () => setArchiveStatus("error"),
    );
  }, []);

  useEffect(() => {
    const services = getFirebaseServices();
    if (!services) return;

    return onSnapshot(
      collection(services.db, "collections"),
      (snapshot) => {
        const nextCollections = snapshot.docs.map((document) => collectionFromDocument(document.id, document.data()));
        setCollections(sortCollections(nextCollections));
        loadedArchiveData.current.collections = true;
        if (loadedArchiveData.current.pieces) setArchiveStatus("ready");
      },
      () => setArchiveStatus("error"),
    );
  }, []);

  const wallPieces = useMemo(
    () => showTestEntries ? [...developmentTestPieces, ...pieces] : pieces,
    [pieces, showTestEntries],
  );

  const visibleCollections = useMemo(
    () => showTestEntries && developmentTestCollection ? [developmentTestCollection, ...collections] : collections,
    [collections, showTestEntries],
  );

  const readAgainPieceId = useMemo(() => {
    const visiblePieceIds = new Set(wallPieces.map((piece) => piece.id));
    return [...visitedPieces].reverse().find((pieceId) => visiblePieceIds.has(pieceId)) ?? null;
  }, [visitedPieces, wallPieces]);

  const selectedIndex = useMemo(
    () => (selected ? wallPieces.findIndex((piece) => piece.id === selected.id) : -1),
    [selected, wallPieces],
  );

  const activeCollection = useMemo(
    () => visibleCollections.find((collection) => collection.id === selected?.collection),
    [selected, visibleCollections],
  );

  const collectionPieces = useMemo(
    () => (selected ? wallPieces.filter((piece) => piece.collection === selected.collection) : []),
    [selected, wallPieces],
  );

  const shelfCollections = useMemo(
    () => collections.filter((item) => pieces.some((piece) => piece.collection === item.id)),
    [collections, pieces],
  );

  const collectionPieceIndex = selected
    ? collectionPieces.findIndex((piece) => piece.id === selected.id)
    : -1;

  const driftSeed = driftPiece ? getStableSeed(driftPiece.id) : 0;
  const driftCollection = driftPiece
    ? visibleCollections.find((collection) => collection.id === driftPiece.collection)
    : null;
  const driftStyle = driftPiece ? {
    "--drift-entry-x": `${driftSeed % 2 === 0 ? -64 : 64}px`,
    "--drift-entry-y": `${28 + driftSeed % 34}px`,
    "--drift-rotate": `${((driftSeed % 9) - 4) * .22}deg`,
  } as React.CSSProperties : undefined;

  useEffect(() => {
    if (view !== "wall" || wallPieces.length === 0) return;

    let observer: IntersectionObserver | null = null;
    const observeCards = window.requestAnimationFrame(() => {
      observer = new IntersectionObserver(
        (entries) => {
          setRevealedPromptPieces((current) => {
            const next = new Set(current);
            let changed = false;
            entries.forEach((entry) => {
              const pieceId = (entry.target as HTMLElement).dataset.promptCard;
              if (!pieceId) return;
              const isInAttentionZone = entry.isIntersecting && entry.intersectionRatio >= .45;
              if (isInAttentionZone && !next.has(pieceId)) {
                next.add(pieceId);
                changed = true;
              } else if (!isInAttentionZone && next.delete(pieceId)) {
                changed = true;
              }
            });
            if (!changed) return current;
            return next;
          });
        },
        { rootMargin: "-8% 0px -14%", threshold: [.45] },
      );

      document.querySelectorAll<HTMLElement>("[data-prompt-card]").forEach((card) => observer?.observe(card));
    });

    return () => {
      window.cancelAnimationFrame(observeCards);
      observer?.disconnect();
    };
  }, [view, wallPieces]);

  useEffect(() => {
    document.body.style.overflow = selected ? "hidden" : "";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [selected]);

  const openPiece = (piece: Piece) => {
    setSelected(piece);
    if (piece.id.startsWith("__test_")) {
      setPreparedPieces((current) => {
        const next = new Set(current);
        next.delete(piece.id);
        return next;
      });
      return;
    }
    setVisitedPieces((current) => {
      if (current.has(piece.id)) return current;
      const next = new Set(current);
      next.add(piece.id);
      rememberSet(VISITED_STORAGE_KEY, next);
      return next;
    });
  };

  const openCollection = (collectionId: string) => {
    const firstPiece = pieces.find((piece) => piece.collection === collectionId);
    if (firstPiece) openPiece(firstPiece);
  };

  const drift = () => {
    if (wallPieces.length === 0) return;
    const unseenPieces = wallPieces.filter((piece) => piece.id.startsWith("__test_") || !visitedPieces.has(piece.id));
    const pool = unseenPieces.length > 0 ? unseenPieces : wallPieces;
    setDriftPiece(pool[Math.floor(Math.random() * pool.length)]);
  };

  const followDrift = () => {
    if (!driftPiece) return;
    const piece = driftPiece;
    setDriftPiece(null);
    openPiece(piece);
  };

  const moveReader = (direction: -1 | 1) => {
    if (collectionPieceIndex < 0 || collectionPieces.length === 0) return;
    const nextIndex = (collectionPieceIndex + direction + collectionPieces.length) % collectionPieces.length;
    openPiece(collectionPieces[nextIndex]);
  };

  const startShelfDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || event.button !== 0 || !shelfRef.current) return;
    shelfDrag.current = {
      active: true,
      moved: false,
      startX: event.clientX,
      scrollLeft: shelfRef.current.scrollLeft,
    };
  };

  const dragShelf = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!shelfDrag.current.active || !shelfRef.current) return;
    const distance = event.clientX - shelfDrag.current.startX;
    if (Math.abs(distance) > 5 && !shelfDrag.current.moved) {
      shelfDrag.current.moved = true;
      shelfRef.current.setPointerCapture(event.pointerId);
      setIsDraggingShelf(true);
    }
    if (!shelfDrag.current.moved) return;
    shelfRef.current.scrollLeft = shelfDrag.current.scrollLeft - distance * 1.15;
  };

  const endShelfDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!shelfDrag.current.active || !shelfRef.current) return;
    const moved = shelfDrag.current.moved;
    shelfDrag.current.active = false;
    if (shelfRef.current.hasPointerCapture(event.pointerId)) {
      shelfRef.current.releasePointerCapture(event.pointerId);
    }
    setIsDraggingShelf(false);
    if (moved) {
      window.setTimeout(() => {
        shelfDrag.current.moved = false;
      }, 0);
    }
  };

  const stopBookClickAfterDrag = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!shelfDrag.current.moved) return;
    event.preventDefault();
    event.stopPropagation();
    shelfDrag.current.moved = false;
  };

  const markReached = async (pieceId: string) => {
    if (reachedPieces.has(pieceId)) return;
    setReachedPieces((current) => {
      const next = new Set(current);
      next.add(pieceId);
      rememberSet(REACHED_STORAGE_KEY, next);
      return next;
    });

    const services = getFirebaseServices();
    if (!services) return;
    let visitorId = window.localStorage.getItem(VISITOR_STORAGE_KEY);
    if (!visitorId) {
      visitorId = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      window.localStorage.setItem(VISITOR_STORAGE_KEY, visitorId);
    }
    try {
      await setDoc(doc(services.db, "responses", `${pieceId}_${visitorId}`), {
        pieceId,
        createdAt: serverTimestamp(),
      });
    } catch {
      // The private, local mark remains even if the anonymous signal cannot be delivered.
    }
  };

  const preparePiece = (piece: Piece, interaction: WallInteraction) => {
    if (interaction === "hold") return;
    if (visitedPieces.has(piece.id)) {
      openPiece(piece);
      return;
    }
    if (interaction === "none") {
      openPiece(piece);
      return;
    }
    if (preparedPieces.has(piece.id)) {
      openPiece(piece);
      return;
    }
    setPreparedPieces((current) => new Set(current).add(piece.id));
  };

  const startHold = (piece: Piece, interaction: WallInteraction) => {
    if (interaction !== "hold") return;
    setHoldingPieceId(piece.id);
    holdTimer.current = window.setTimeout(() => {
      setHoldingPieceId(null);
      openPiece(piece);
    }, 850);
  };

  const cancelHold = () => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
    setHoldingPieceId(null);
  };

  const activateRitualDemo = (interaction: WallInteraction) => {
    if (interaction === "hold") return;
    if (interaction === "none") {
      setRitualDemoStates((current) => ({ ...current, none: current.none === "opened" ? "idle" : "opened" }));
      return;
    }
    setRitualDemoStates((current) => ({
      ...current,
      [interaction]: current[interaction] === "idle"
        ? "prepared"
        : current[interaction] === "prepared"
          ? "opened"
          : "idle",
    }));
  };

  const startRitualHold = () => {
    setRitualDemoStates((current) => ({ ...current, hold: "holding" }));
    ritualHoldTimer.current = window.setTimeout(() => {
      ritualHoldTimer.current = null;
      setRitualDemoStates((current) => ({ ...current, hold: "opened" }));
    }, 850);
  };

  const endRitualHold = () => {
    if (ritualHoldTimer.current === null) return;
    window.clearTimeout(ritualHoldTimer.current);
    ritualHoldTimer.current = null;
    setRitualDemoStates((current) => ({ ...current, hold: "idle" }));
  };

  const resetRitualDemos = () => {
    endRitualHold();
    setRitualDemoStates({ none: "idle", hold: "idle", uncover: "idle", turn: "idle" });
  };

  return (
    <main className={`${styles.page} ${styles[`mood_${timeMood}`]}`}>
      <header className={styles.header}>
        <button className={styles.wordmark} onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
          Marginalia<span>archive</span>
        </button>
        <nav className={styles.nav} aria-label="Archive views">
          <button className={view === "wall" ? styles.activeNav : ""} onClick={() => setView("wall")}>
            Wall
          </button>
          <button className={view === "shelf" ? styles.activeNav : ""} onClick={() => setView("shelf")}>
            Shelf
          </button>
          <button className={styles.driftTrigger} onClick={drift}>Drift</button>
        </nav>
        <p className={styles.issue}>2026</p>
      </header>

      <section className={styles.hero}>
        <h1>
          Words they may <em>never read.</em>
        </h1>
      </section>

      {view === "wall" ? (
        <section className={styles.archive} aria-labelledby="wall-heading">
          <div className={styles.sectionHeading}>
            <h2 id="wall-heading">Archive</h2>
            <div className={styles.sectionMeta}>
              <p>{wallPieces.length} {wallPieces.length === 1 ? "entry" : "entries"}</p>
              {process.env.NODE_ENV === "development" && <button onClick={() => setShowTestEntries((current) => !current)}>{showTestEntries ? "Hide test entries" : "Show test entries"}</button>}
              {process.env.NODE_ENV === "development" && <button onClick={() => setShowOpeningLab(true)}>Test openings</button>}
            </div>
          </div>
          {archiveStatus === "loading" && (
            <div className={styles.archiveNotice} role="status">
              <p>Opening the archive</p>
              <span>Gathering the published pieces…</span>
            </div>
          )}
          {archiveStatus === "unconfigured" && (
            <div className={styles.archiveNotice}>
              <p>The archive is waiting to be connected.</p>
              <span>Add the Firebase web configuration to begin publishing.</span>
            </div>
          )}
          {archiveStatus === "error" && (
            <div className={styles.archiveNotice} role="alert">
              <p>The archive could not be opened.</p>
              <span>Check the Firestore connection and public read rules.</span>
            </div>
          )}
          {archiveStatus === "ready" && wallPieces.length === 0 && (
            <div className={styles.archiveNotice}>
              <p>Nothing has been placed here yet.</p>
              <span>The first published piece will appear on this wall.</span>
            </div>
          )}
          {archiveStatus === "ready" && wallPieces.length > 0 && <div className={styles.masonry}>
            {wallPieces.map((piece, index) => {
              const profile = getPresentationProfile(piece.id);
              const interaction = piece.interaction === "random" ? profile.interaction : piece.interaction;
              const tone = resolvePieceTone(piece.tone, piece.id);
              const pieceCollection = visibleCollections.find((item) => item.id === piece.collection);
              const isPrepared = preparedPieces.has(piece.id);
              const isVisited = visitedPieces.has(piece.id);
              const showReadAgain = isVisited && piece.id === readAgainPieceId;
              const cardStyle = {
                "--card-tilt": `${profile.tilt}deg`,
                "--grain-opacity": profile.grain,
                "--card-enter-delay": `${Math.min(index, 12) * 55}ms`,
              } as React.CSSProperties;

              return (
                <button
                  key={piece.id}
                  className={`${styles.card} ${styles[tone]} ${styles[piece.size === "random" ? profile.size : piece.size]} ${styles[`variant${profile.variant}`]} ${styles[`personality${getCollectionPersonality(piece.collection)}`]} ${styles[`interaction_${interaction}`]} ${isVisited ? styles.visited : ""} ${isPrepared ? styles.prepared : ""} ${holdingPieceId === piece.id ? styles.holding : ""} ${revealedPromptPieces.has(piece.id) ? styles.promptRevealed : ""}`}
                  data-prompt-card={piece.id}
                  style={cardStyle}
                  onClick={() => preparePiece(piece, interaction)}
                  onPointerDown={() => startHold(piece, interaction)}
                  onPointerUp={cancelHold}
                  onPointerLeave={cancelHold}
                  onPointerCancel={cancelHold}
                  onContextMenu={(event) => {
                    if (interaction === "hold") event.preventDefault();
                  }}
                  onKeyDown={(event) => {
                    if (interaction === "hold" && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      openPiece(piece);
                    }
                  }}
                  aria-label={`${interaction === "hold" ? "Hold to open" : isVisited ? "Read again" : interaction === "none" ? "Read" : isPrepared ? "Open" : interaction === "uncover" ? "Uncover" : "Turn over"}: ${piece.title}`}
                >
                  <span className={styles.cardTurner}>
                    <span className={`${styles.cardFace} ${styles.cardFront}`}>
                      <span className={styles.interactionVeil} aria-hidden="true" />
                      {interaction === "uncover" && <span className={styles.archiveSeal} aria-hidden="true">M</span>}
                      {interaction === "hold" && <span className={styles.holdField} aria-hidden="true"><span /></span>}
                      <span className={styles.cardNumber}>M–{String(index + 1).padStart(3, "0")}</span>
                      <span className={styles.cardKind}>{pieceCollection?.title ?? "Unfiled"}</span>
                      <span className={styles.cardBody}>
                        <strong>{piece.title}</strong>
                        {profile.variant !== 4 && <span>{piece.excerpt}</span>}
                      </span>
                      <span className={styles.cardDate}>
                        {piece.date}{piece.time ? ` · ${piece.time}` : ""}
                      </span>
                      {(interaction === "hold" || showReadAgain || (!isVisited && interaction !== "none")) && <span className={styles.interactionCue} aria-hidden="true">
                        {interaction === "hold" ? holdingPieceId === piece.id ? "Keep Holding" : "Hold to Open" : showReadAgain ? "Read Again" : isPrepared ? "Open the piece" : interaction === "uncover" ? "Break the seal" : "Turn the card"}
                      </span>}
                    </span>
                    <span className={`${styles.cardFace} ${styles.cardBack}`} aria-hidden="true">
                      <small>Reverse · M–{String(index + 1).padStart(3, "0")}</small>
                      <strong>{piece.title}</strong>
                      <span>{piece.excerpt || pieceCollection?.title || "A page kept in the archive."}</span>
                      <b>{pieceCollection?.title ?? "Unfiled"} · {piece.date}</b>
                      <i>Open the piece →</i>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>}
        </section>
      ) : (
        <section className={styles.shelfRoom} aria-labelledby="shelf-heading">
          <div className={styles.shelfHeading}>
            <div>
              <h2 id="shelf-heading">Collections</h2>
            </div>
            <p>Drag to browse</p>
          </div>
          {archiveStatus === "ready" && shelfCollections.length > 0 ? <div
            ref={shelfRef}
            className={`${styles.books} ${isDraggingShelf ? styles.dragging : ""}`}
            onPointerDown={startShelfDrag}
            onPointerMove={dragShelf}
            onPointerUp={endShelfDrag}
            onPointerCancel={endShelfDrag}
            onClickCapture={stopBookClickAfterDrag}
          >
            {shelfCollections.map((collection, index) => {
              const count = pieces.filter((piece) => piece.collection === collection.id).length;
              return (
                <button
                  className={`${styles.book} ${styles[`personality${getCollectionPersonality(collection.id)}`]}`}
                  style={{ "--book-color": collection.color } as React.CSSProperties}
                  key={collection.id}
                  onClick={() => openCollection(collection.id)}
                >
                  <span className={styles.bookIndex}>Volume {String(index + 1).padStart(2, "0")}</span>
                  <span className={styles.bookTitle}>{collection.title}</span>
                  <span className={styles.bookRule} />
                  <span className={styles.bookSubtitle}>{collection.subtitle}</span>
                  <span className={styles.bookCount}>{count} pieces</span>
                </button>
              );
            })}
          </div> : (
            <div className={`${styles.archiveNotice} ${styles.shelfNotice}`}>
              <p>{archiveStatus === "loading" ? "Opening the volumes" : "The shelf is waiting."}</p>
              <span>Published pieces will gather here by collection.</span>
            </div>
          )}
          {archiveStatus === "ready" && shelfCollections.length > 0 && <div className={styles.shelfEdge} />}
        </section>
      )}

      <footer className={styles.footer}>
        <p>Marginalia · 2026</p>
      </footer>

      {driftPiece && (
        <div className={styles.driftScene} role="dialog" aria-modal="true" aria-labelledby="drift-fragment">
          <button className={styles.driftBackdrop} aria-label="Let the fragment pass" onClick={() => setDriftPiece(null)} />
          <div className={styles.driftAtmosphere} aria-hidden="true"><span /><span /><span /></div>
          <div className={styles.driftArrival} style={driftStyle}>
            <section className={styles.driftFragment}>
              <header><p>Drift</p><span>{driftCollection?.title ?? "Unfiled"}</span></header>
              <blockquote id="drift-fragment">
                {driftPiece.excerpt || driftPiece.body.split(/\r?\n/).find(Boolean) || "A page without a beginning."}
              </blockquote>
              <small>{driftPiece.title}</small>
              <footer className={styles.driftActions}>
                <button onClick={() => setDriftPiece(null)}>Let it pass</button>
                <button onClick={followDrift}>Follow →</button>
              </footer>
            </section>
          </div>
        </div>
      )}

      {showOpeningLab && process.env.NODE_ENV === "development" && (
        <div className={styles.openingLab} role="dialog" aria-modal="true" aria-labelledby="opening-lab-title">
          <button className={styles.openingLabBackdrop} aria-label="Close opening lab" onClick={() => setShowOpeningLab(false)} />
          <section className={styles.openingLabPanel}>
            <header>
              <div><p>Local preview</p><h2 id="opening-lab-title">Opening rituals</h2></div>
              <button onClick={() => setShowOpeningLab(false)}>Close</button>
            </header>
            <p className={styles.openingLabIntro}>Try each card repeatedly. This testing room is removed from production.</p>
            <div className={styles.ritualDemoGrid}>
              {(["none", "hold", "uncover", "turn"] as WallInteraction[]).map((interaction) => {
                const state = ritualDemoStates[interaction];
                const isPrepared = state === "prepared" || state === "opened";
                return (
                  <button
                    className={`${styles.ritualDemo} ${styles[`interaction_${interaction}`]} ${isPrepared ? styles.prepared : ""} ${state === "holding" ? styles.holding : ""} ${state === "opened" ? styles.demoOpened : ""}`}
                    key={interaction}
                    onClick={() => {
                      if (interaction === "hold") return;
                      if (state === "opened") setRitualDemoStates((current) => ({ ...current, [interaction]: "idle" }));
                      else activateRitualDemo(interaction);
                    }}
                    onKeyDown={(event) => {
                      if (interaction === "hold" && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        setRitualDemoStates((current) => ({ ...current, hold: "opened" }));
                      }
                    }}
                    onPointerDown={interaction === "hold" ? startRitualHold : undefined}
                    onPointerUp={interaction === "hold" ? endRitualHold : undefined}
                    onPointerLeave={interaction === "hold" ? endRitualHold : undefined}
                    onPointerCancel={interaction === "hold" ? endRitualHold : undefined}
                    onContextMenu={(event) => {
                      if (interaction === "hold") event.preventDefault();
                    }}
                  >
                    <span className={styles.cardTurner}>
                      <span className={`${styles.cardFace} ${styles.cardFront} ${styles.labFront}`}>
                        <span className={styles.interactionVeil} aria-hidden="true" />
                        {interaction === "uncover" && <span className={styles.archiveSeal} aria-hidden="true">M</span>}
                        {interaction === "hold" && <span className={styles.holdField} aria-hidden="true"><span /></span>}
                        <small>Interaction test</small>
                        <strong>{interaction === "none" ? "Normal" : interaction === "hold" ? "Hold" : interaction === "uncover" ? "Uncover" : "Turn over"}</strong>
                        <span className={styles.demoResult}>{state === "opened" ? "Opened — tap to reset" : interaction === "none" ? "One click. No opening ritual." : "A page waiting to be found."}</span>
                        <span className={styles.interactionCue} aria-hidden="true">
                          {state === "opened" ? interaction === "hold" ? "Opened" : "Reset" : interaction === "none" ? "Open normally" : interaction === "hold" ? state === "holding" ? "Keep Holding" : "Hold to Open" : state === "prepared" ? "Open the piece" : interaction === "uncover" ? "Break the seal" : "Turn the card"}
                        </span>
                      </span>
                      <span className={`${styles.cardFace} ${styles.cardBack} ${styles.labBack}`} aria-hidden="true">
                        <small>Reverse side</small>
                        <strong>Turned over.</strong>
                        <span>The second gesture opens the piece.</span>
                        <i>{state === "opened" ? "Opened · tap to reset" : "Open the piece →"}</i>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <footer><button onClick={resetRitualDemos}>Reset all</button></footer>
          </section>
        </div>
      )}

      {selected && (
        <div className={styles.reader} role="dialog" aria-modal="true" aria-labelledby="reader-title">
          <button className={styles.readerBackdrop} onClick={() => setSelected(null)} aria-label="Close reader" />
          <article
            className={`${styles.readerBook} ${styles[`personality${getCollectionPersonality(selected.collection)}`]}`}
            style={{ "--collection-color": activeCollection?.color ?? "#756b5f" } as React.CSSProperties}
          >
            <header className={styles.readerHeader}>
              <button className={styles.closeButton} onClick={() => setSelected(null)}>
                <span aria-hidden="true">←</span> Put it back
              </button>
              <p>{selected.date}{selected.time ? ` · ${selected.time}` : ""}</p>
            </header>
            <div className={styles.bookSpread}>
              <aside className={styles.readerVerso}>
                <p className={styles.volumeLabel}>
                  {selected.id.startsWith("__test_")
                    ? "Test volume"
                    : activeCollection
                    ? `Volume ${String(shelfCollections.findIndex((item) => item.id === selected.collection) + 1).padStart(2, "0")}`
                    : "Unfiled"}
                </p>
                <div className={styles.collectionMark} aria-hidden="true">
                  {activeCollection?.title.charAt(0) ?? "·"}
                </div>
                <div className={styles.readerCollection}>
                  <h3>{activeCollection?.title ?? "Unfiled"}</h3>
                </div>
              </aside>
              <div className={styles.readerRecto}>
                <p className={styles.readerKicker}>Entry {String(selectedIndex + 1).padStart(2, "0")}</p>
                <h2 id="reader-title">{selected.title}</h2>
                <div className={styles.poem}>{selected.body}</div>
                {!selected.id.startsWith("__test_") && <button
                  className={`${styles.reachedButton} ${reachedPieces.has(selected.id) ? styles.reached : ""}`}
                  aria-pressed={reachedPieces.has(selected.id)}
                  onClick={() => void markReached(selected.id)}
                  disabled={reachedPieces.has(selected.id)}
                >
                  <span aria-hidden="true">{reachedPieces.has(selected.id) ? "●" : "○"}</span>
                  {reachedPieces.has(selected.id) ? "Kept with me" : "This reached me"}
                </button>}
              </div>
            </div>
            <footer className={styles.readerFooter}>
              <button onClick={() => moveReader(-1)}>← Previous</button>
              <div className={styles.pageProgress} aria-label={`Piece ${collectionPieceIndex + 1} of ${collectionPieces.length} in this volume`}>
                {collectionPieces.map((piece, index) => (
                  <span className={index === collectionPieceIndex ? styles.currentPage : ""} key={piece.id} />
                ))}
              </div>
              <button onClick={() => moveReader(1)}>Next →</button>
            </footer>
          </article>
        </div>
      )}
    </main>
  );
}
