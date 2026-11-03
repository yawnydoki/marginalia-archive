"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import {
  collectionFromDocument,
  emptyCollection,
  emptyPiece,
  pieceFromDocument,
  resolvePieceTone,
  sortCollections,
  sortPieces,
  type ArchiveCollection,
  type CollectionDraft,
  type Piece,
  type PieceDraft,
} from "@/lib/content";
import { getFirebaseServices, isFirebaseConfigured } from "@/lib/firebase";
import styles from "./studio.module.css";

type StudioState = "checking" | "signed-out" | "signed-in" | "unconfigured";
type StatusFilter = "all" | "draft" | "published";

function getErrorMessage(error: unknown) {
  if (typeof error === "object" && error && "code" in error) {
    const code = String(error.code);
    if (code.includes("invalid-credential")) return "That email or password was not accepted.";
    if (code.includes("too-many-requests")) return "Too many attempts. Wait a moment and try again.";
    if (code.includes("permission-denied")) return "Firestore denied this action. Deploy the latest security rules.";
  }
  return "Something interrupted the request. Please try again.";
}

function toDraft(piece: Piece): PieceDraft {
  return {
    title: piece.title,
    kind: piece.kind,
    date: piece.date,
    time: piece.time,
    collection: piece.collection,
    excerpt: piece.excerpt,
    body: piece.body,
    tone: piece.tone,
    size: piece.size,
    interaction: piece.interaction,
    published: piece.published,
  };
}

export default function StudioPage() {
  const [studioState, setStudioState] = useState<StudioState>(isFirebaseConfigured ? "checking" : "unconfigured");
  const [user, setUser] = useState<User | null>(null);
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [collections, setCollections] = useState<ArchiveCollection[]>([]);
  const [responseCounts, setResponseCounts] = useState<Record<string, number>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PieceDraft>({ ...emptyPiece });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [focusMode, setFocusMode] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [showCollections, setShowCollections] = useState(false);
  const [editingCollectionId, setEditingCollectionId] = useState<string | null>(null);
  const [collectionDraft, setCollectionDraft] = useState<CollectionDraft>({ ...emptyCollection });
  const [collectionMessage, setCollectionMessage] = useState("");
  const editVersion = useRef(0);

  useEffect(() => {
    const services = getFirebaseServices();
    if (!services) return;
    return onAuthStateChanged(services.auth, (nextUser) => {
      setUser(nextUser);
      setStudioState(nextUser ? "signed-in" : "signed-out");
    });
  }, []);

  useEffect(() => {
    if (studioState !== "signed-in") return;
    const services = getFirebaseServices();
    if (!services) return;

    const unsubscribePieces = onSnapshot(
      collection(services.db, "pieces"),
      (snapshot) => setPieces(sortPieces(snapshot.docs.map((item) => pieceFromDocument(item.id, item.data())))),
      (error) => setMessage(getErrorMessage(error)),
    );
    const unsubscribeCollections = onSnapshot(
      collection(services.db, "collections"),
      (snapshot) => setCollections(sortCollections(snapshot.docs.map((item) => collectionFromDocument(item.id, item.data())))),
      (error) => setMessage(getErrorMessage(error)),
    );
    const unsubscribeResponses = onSnapshot(
      collection(services.db, "responses"),
      (snapshot) => {
        const nextCounts: Record<string, number> = {};
        snapshot.docs.forEach((item) => {
          const pieceId = item.data().pieceId;
          if (typeof pieceId === "string") nextCounts[pieceId] = (nextCounts[pieceId] ?? 0) + 1;
        });
        setResponseCounts(nextCounts);
      },
      (error) => setMessage(getErrorMessage(error)),
    );

    return () => {
      unsubscribePieces();
      unsubscribeCollections();
      unsubscribeResponses();
    };
  }, [studioState]);

  useEffect(() => {
    const protectUnsavedWork = (event: BeforeUnloadEvent) => {
      if (!isDirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", protectUnsavedWork);
    return () => window.removeEventListener("beforeunload", protectUnsavedWork);
  }, [isDirty]);

  const selectedPiece = useMemo(
    () => pieces.find((piece) => piece.id === selectedId) ?? null,
    [pieces, selectedId],
  );

  const activeCollection = useMemo(
    () => collections.find((item) => item.id === draft.collection) ?? null,
    [collections, draft.collection],
  );

  const filteredPieces = useMemo(() => {
    const term = search.trim().toLowerCase();
    return pieces.filter((piece) => {
      const matchesSearch = !term || piece.title.toLowerCase().includes(term) || piece.body.toLowerCase().includes(term);
      const matchesStatus = statusFilter === "all" || (statusFilter === "published" ? piece.published : !piece.published);
      return matchesSearch && matchesStatus;
    });
  }, [pieces, search, statusFilter]);

  const counts = useMemo(() => {
    const content = draft.body.trim();
    return {
      words: content ? content.split(/\s+/).length : 0,
      lines: content ? content.split(/\r?\n/).length : 0,
      stanzas: content ? content.split(/\n\s*\n/).filter(Boolean).length : 0,
    };
  }, [draft.body]);

  const publishedCount = pieces.filter((piece) => piece.published).length;
  const previewTone = resolvePieceTone(draft.tone, selectedId ?? "new-entry");

  const updateField = <Key extends keyof PieceDraft>(field: Key, value: PieceDraft[Key]) => {
    editVersion.current += 1;
    setDraft((current) => ({ ...current, [field]: value }));
    setIsDirty(true);
    setMessage("");
  };

  const confirmDiscard = () => !isDirty || window.confirm("Discard the unsaved changes on this page?");

  const selectPiece = (piece: Piece) => {
    if (!confirmDiscard()) return;
    editVersion.current = 0;
    setSelectedId(piece.id);
    setDraft(toDraft(piece));
    setIsDirty(false);
    setLastSavedAt(null);
    setMessage("");
  };

  const startNewPiece = () => {
    if (!confirmDiscard()) return;
    editVersion.current = 0;
    setSelectedId(null);
    setDraft({ ...emptyPiece, collection: collections[0]?.id ?? "" });
    setIsDirty(false);
    setLastSavedAt(null);
    setMessage("");
  };

  const persistDraft = useCallback(async (published: boolean, quiet = false) => {
    const services = getFirebaseServices();
    if (!services || !draft.title.trim() || !draft.body.trim() || !draft.collection) {
      if (!quiet) setMessage("A title, collection, and body are required.");
      return;
    }

    const savingVersion = editVersion.current;
    setIsSaving(true);
    if (!quiet) setMessage("");
    const payload = {
      ...draft,
      published,
      title: draft.title.trim(),
      excerpt: draft.excerpt.trim(),
      body: draft.body.trim(),
      updatedAt: serverTimestamp(),
    };

    try {
      let pieceId = selectedId;
      if (pieceId) {
        await updateDoc(doc(services.db, "pieces", pieceId), payload);
      } else {
        const created = await addDoc(collection(services.db, "pieces"), { ...payload, createdAt: serverTimestamp() });
        pieceId = created.id;
        setSelectedId(created.id);
      }
      const savedAt = Date.now();
      const savedPiece: Piece = {
        id: pieceId,
        ...draft,
        published,
        title: payload.title,
        excerpt: payload.excerpt,
        body: payload.body,
        updatedAt: { toMillis: () => savedAt },
      };
      setPieces((current) => sortPieces([savedPiece, ...current.filter((piece) => piece.id !== savedPiece.id)]));
      setDraft((current) => ({ ...current, published }));
      setLastSavedAt(new Date());
      if (editVersion.current === savingVersion) setIsDirty(false);
      if (!quiet) setMessage(published ? "Published changes saved." : "Draft saved privately.");
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  }, [draft, selectedId]);

  useEffect(() => {
    if (!selectedId || !isDirty || isSaving || draft.published) return;
    const autosave = window.setTimeout(() => void persistDraft(draft.published, true), 1400);
    return () => window.clearTimeout(autosave);
  }, [draft, isDirty, isSaving, persistDraft, selectedId]);

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void persistDraft(draft.published);
    };
    window.addEventListener("keydown", saveShortcut);
    return () => window.removeEventListener("keydown", saveShortcut);
  }, [draft.published, persistDraft]);

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const services = getFirebaseServices();
    if (!services) return;
    setMessage("");
    try {
      await signInWithEmailAndPassword(services.auth, email.trim(), password);
      setPassword("");
    } catch (error) {
      setMessage(getErrorMessage(error));
    }
  };

  const handleDeletePiece = async () => {
    if (!selectedId || !selectedPiece || !window.confirm(`Permanently delete “${selectedPiece.title}”?`)) return;
    const services = getFirebaseServices();
    if (!services) return;
    try {
      await deleteDoc(doc(services.db, "pieces", selectedId));
      editVersion.current = 0;
      setSelectedId(null);
      setDraft({ ...emptyPiece, collection: collections[0]?.id ?? "" });
      setIsDirty(false);
      setMessage("Piece deleted.");
    } catch (error) {
      setMessage(getErrorMessage(error));
    }
  };

  const openNewCollection = () => {
    setEditingCollectionId(null);
    setCollectionDraft({ ...emptyCollection });
    setCollectionMessage("");
    setShowCollections(true);
  };

  const editCollection = (item: ArchiveCollection) => {
    setEditingCollectionId(item.id);
    setCollectionDraft({ title: item.title, subtitle: item.subtitle, color: item.color });
    setCollectionMessage("");
  };

  const saveCollection = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!collectionDraft.title.trim()) {
      setCollectionMessage("Give the collection a name.");
      return;
    }
    const services = getFirebaseServices();
    if (!services) return;
    const payload = {
      ...collectionDraft,
      title: collectionDraft.title.trim(),
      subtitle: collectionDraft.subtitle.trim(),
      updatedAt: serverTimestamp(),
    };
    try {
      if (editingCollectionId) {
        await updateDoc(doc(services.db, "collections", editingCollectionId), payload);
        setCollectionMessage("Collection updated.");
      } else {
        const created = await addDoc(collection(services.db, "collections"), { ...payload, createdAt: serverTimestamp() });
        updateField("collection", created.id);
        setEditingCollectionId(created.id);
        setCollectionMessage("Collection created and selected.");
      }
    } catch (error) {
      setCollectionMessage(getErrorMessage(error));
    }
  };

  const deleteCollection = async (item: ArchiveCollection) => {
    const entryCount = pieces.filter((piece) => piece.collection === item.id).length;
    if (entryCount > 0) {
      setCollectionMessage(`Move or delete the ${entryCount} ${entryCount === 1 ? "entry" : "entries"} in this collection first.`);
      return;
    }
    if (!window.confirm(`Delete the empty collection “${item.title}”?`)) return;
    const services = getFirebaseServices();
    if (!services) return;
    try {
      await deleteDoc(doc(services.db, "collections", item.id));
      if (draft.collection === item.id) updateField("collection", "");
      setEditingCollectionId(null);
      setCollectionDraft({ ...emptyCollection });
      setCollectionMessage("Collection deleted.");
    } catch (error) {
      setCollectionMessage(getErrorMessage(error));
    }
  };

  if (studioState === "unconfigured") {
    return (
      <main className={styles.centeredPage}>
        <section className={styles.setupCard}>
          <p className={styles.kicker}>Marginalia · private studio</p>
          <h1>Connect Firebase first.</h1>
          <p>Copy <code>.env.local.example</code> to <code>.env.local</code>, then paste the Firebase web app values.</p>
          <Link href="/">Return to the archive</Link>
        </section>
      </main>
    );
  }

  if (studioState === "checking") {
    return <main className={styles.centeredPage}><p className={styles.loading}>Opening the studio…</p></main>;
  }

  if (studioState === "signed-out") {
    return (
      <main className={styles.centeredPage}>
        <section className={styles.loginCard}>
          <div>
            <p className={styles.kicker}>Marginalia · private studio</p>
            <h1>The room behind the archive.</h1>
            <p>Sign in with the owner account created in Firebase Authentication.</p>
          </div>
          <form onSubmit={handleLogin}>
            <label>Email<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
            <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            {message && <p className={styles.formMessage} role="alert">{message}</p>}
            <button type="submit">Enter the studio</button>
          </form>
          <Link href="/">← Return to the public archive</Link>
        </section>
      </main>
    );
  }

  return (
    <main className={`${styles.studio} ${focusMode ? styles.focusMode : ""}`}>
      <header className={styles.studioHeader}>
        <div><p className={styles.kicker}>Marginalia · private studio</p><h1>Writing desk</h1></div>
        <div className={styles.account}>
          <span>{user?.email}</span>
          <Link href="/">View archive ↗</Link>
          <button onClick={() => { const services = getFirebaseServices(); if (services) void signOut(services.auth); }}>Sign out</button>
        </div>
      </header>

      <section className={`${styles.workspace} ${!showPreview ? styles.previewClosed : ""}`}>
        <aside className={styles.library}>
          <div className={styles.libraryHeader}>
            <div><p>{pieces.length} total · {publishedCount} public</p><h2>Entries</h2></div>
            <button onClick={startNewPiece}>New</button>
          </div>
          <div className={styles.libraryTools}>
            <input aria-label="Search entries" placeholder="Search entries" value={search} onChange={(event) => setSearch(event.target.value)} />
            <select aria-label="Filter entries" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
              <option value="all">All entries</option><option value="draft">Drafts</option><option value="published">Published</option>
            </select>
            <button onClick={openNewCollection}>Manage collections</button>
          </div>
          <div className={styles.pieceList}>
            {filteredPieces.length === 0 && <p className={styles.emptyList}>{pieces.length ? "No entries match this view." : "No pieces yet. Begin with a blank page."}</p>}
            {filteredPieces.map((piece) => {
              const itemCollection = collections.find((item) => item.id === piece.collection);
              return (
                <button key={piece.id} className={piece.id === selectedId ? styles.selectedPiece : ""} onClick={() => selectPiece(piece)}>
                  <span>{piece.published ? "Public" : "Draft"}</span>
                  <strong>{piece.title}</strong>
                  <small>{piece.kind} · {itemCollection?.title ?? "Unfiled"}{responseCounts[piece.id] ? ` · ${responseCounts[piece.id]} reached` : ""}</small>
                </button>
              );
            })}
          </div>
        </aside>

        <form className={styles.editor} onSubmit={(event) => { event.preventDefault(); void persistDraft(draft.published); }}>
          <div className={styles.editorTopline}>
            <p>{selectedId ? "Editing entry" : "New entry"} · {isSaving ? "Saving…" : isDirty ? "Unsaved changes" : lastSavedAt ? "Saved" : "Not yet saved"}</p>
            <div className={styles.viewTools}>
              <button type="button" onClick={() => setShowPreview((current) => !current)}>{showPreview ? "Hide preview" : "Show preview"}</button>
              <button type="button" onClick={() => setFocusMode((current) => !current)}>{focusMode ? "Leave focus" : "Focus mode"}</button>
            </div>
          </div>

          {collections.length === 0 && (
            <button className={styles.collectionPrompt} type="button" onClick={openNewCollection}>
              Create your first collection before saving an entry →
            </button>
          )}

          <label className={styles.titleField}><span>Title</span><input value={draft.title} onChange={(event) => updateField("title", event.target.value)} placeholder="Untitled" required /></label>

          <div className={styles.fieldGrid}>
            <label>Kind<select value={draft.kind} onChange={(event) => updateField("kind", event.target.value as PieceDraft["kind"])}><option value="poem">Poem</option><option value="letter">Letter</option><option value="fragment">Fragment</option><option value="memory">Memory</option></select></label>
            <label>Collection<select value={draft.collection} onChange={(event) => updateField("collection", event.target.value)}><option value="">Choose collection</option>{collections.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
            <label>Display date<input value={draft.date} onChange={(event) => updateField("date", event.target.value)} /></label>
            <label>Time written<input type="time" value={draft.time} onChange={(event) => updateField("time", event.target.value)} /></label>
            <label>Tone<select value={draft.tone} onChange={(event) => updateField("tone", event.target.value as PieceDraft["tone"])}><option value="random">Randomized</option><option value="paper">Paper</option><option value="ink">Ink</option><option value="rose">Rose</option><option value="blue">Blue</option><option value="sage">Sage</option><option value="clay">Clay</option></select></label>
            <label>Card size<select value={draft.size} onChange={(event) => updateField("size", event.target.value as PieceDraft["size"])}><option value="random">Randomized</option><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option></select></label>
            <label>Opening interaction<select value={draft.interaction} onChange={(event) => updateField("interaction", event.target.value as PieceDraft["interaction"])}><option value="random">Randomized</option><option value="none">Normal card</option><option value="hold">Hold</option><option value="uncover">Uncover</option><option value="turn">Turn over</option></select></label>
          </div>

          <label>Excerpt<textarea className={styles.excerptField} value={draft.excerpt} onChange={(event) => updateField("excerpt", event.target.value)} placeholder="A short line for the archive wall." /></label>
          <label className={styles.bodyField}>Body<textarea value={draft.body} onChange={(event) => updateField("body", event.target.value)} placeholder="Write the complete piece here…" required /></label>

          <div className={styles.writingStats}><span>{counts.words} words</span><span>{counts.lines} lines</span><span>{counts.stanzas} stanzas</span>{selectedId && <span>{responseCounts[selectedId] ?? 0} reached</span>}<span>Ctrl/⌘ + S to save</span></div>

          <footer className={styles.editorFooter}>
            <div>{selectedId && <button className={styles.deleteButton} type="button" onClick={handleDeletePiece}>Delete entry</button>}{message && <p role="status">{message}</p>}</div>
            <div className={styles.saveActions}>
              {selectedId && <button className={styles.secondaryAction} type="button" onClick={() => void persistDraft(!draft.published)} disabled={isSaving || !draft.collection}>{draft.published ? "Unpublish" : "Publish"}</button>}
              <button className={styles.saveButton} type="submit" disabled={isSaving || !draft.collection}>{isSaving ? "Saving…" : draft.published ? "Save changes" : "Save draft"}</button>
            </div>
          </footer>
        </form>

        {showPreview && (
          <aside className={styles.preview}>
            <p className={styles.kicker}>Reader preview · {activeCollection?.title ?? "Unfiled"}</p>
            <div className={`${styles.previewPaper} ${styles[`tone_${previewTone}`]}`}>
              <span>{draft.kind} · {draft.date || "Undated"}{draft.time ? ` · ${draft.time}` : ""}</span>
              <h2>{draft.title || "Untitled"}</h2>
              <div>{draft.body || "The page is still quiet."}</div>
            </div>
          </aside>
        )}
      </section>

      {showCollections && (
        <div className={styles.collectionOverlay} role="dialog" aria-modal="true" aria-labelledby="collections-title">
          <button className={styles.collectionBackdrop} aria-label="Close collection manager" onClick={() => setShowCollections(false)} />
          <section className={styles.collectionManager}>
            <header><div><p className={styles.kicker}>Archive structure</p><h2 id="collections-title">Collections</h2></div><button onClick={() => setShowCollections(false)}>Close</button></header>
            <div className={styles.collectionWorkspace}>
              <div className={styles.collectionList}>
                <button className={!editingCollectionId ? styles.activeCollectionRow : ""} onClick={openNewCollection}>＋ New collection</button>
                {collections.map((item) => {
                  const count = pieces.filter((piece) => piece.collection === item.id).length;
                  return <button className={editingCollectionId === item.id ? styles.activeCollectionRow : ""} key={item.id} onClick={() => editCollection(item)}><i style={{ background: item.color }} /><span><strong>{item.title}</strong><small>{count} {count === 1 ? "entry" : "entries"}</small></span></button>;
                })}
              </div>
              <form className={styles.collectionForm} onSubmit={saveCollection}>
                <label>Name<input value={collectionDraft.title} onChange={(event) => setCollectionDraft((current) => ({ ...current, title: event.target.value }))} placeholder="Collection name" required /></label>
                <label>Subtitle<input value={collectionDraft.subtitle} onChange={(event) => setCollectionDraft((current) => ({ ...current, subtitle: event.target.value }))} placeholder="A short description" /></label>
                <label>Cover color<div className={styles.colorField}><input type="color" value={collectionDraft.color} onChange={(event) => setCollectionDraft((current) => ({ ...current, color: event.target.value }))} /><input value={collectionDraft.color} onChange={(event) => setCollectionDraft((current) => ({ ...current, color: event.target.value }))} /></div></label>
                {collectionMessage && <p role="status">{collectionMessage}</p>}
                <footer>{editingCollectionId && <button className={styles.deleteButton} type="button" onClick={() => { const item = collections.find((entry) => entry.id === editingCollectionId); if (item) void deleteCollection(item); }}>Delete collection</button>}<button className={styles.saveButton} type="submit">{editingCollectionId ? "Save collection" : "Create collection"}</button></footer>
              </form>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
