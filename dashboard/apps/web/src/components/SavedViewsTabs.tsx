import { useEffect, useState } from "react";
import { Plus, Star, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFilters } from "@/lib/filters";
import { DEFAULT_URL_STATE, parseUrlState, type UrlState } from "@/lib/url-state";
import { deleteSavedView, listSavedViews, saveView, type SavedView } from "@/lib/saved-views";
import { cn } from "@/lib/utils";

const BUILTINS: SavedView[] = [
  { id: "all", name: "All", state: { ...DEFAULT_URL_STATE } },
  { id: "broken", name: "Broken only", state: { ...DEFAULT_URL_STATE, brokenOnly: true } },
  { id: "pending", name: "Pending claims", state: { ...DEFAULT_URL_STATE, search: "" } },
];

export function SavedViewsTabs() {
  const filters = useFilters();
  const [views, setViews] = useState<SavedView[]>(() => listSavedViews());
  const [draftName, setDraftName] = useState("");
  const [draftOpen, setDraftOpen] = useState(false);

  useEffect(() => {
    const onStorage = () => setViews(listSavedViews());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function applyView(state: UrlState) {
    filters.setView(state.view);
    filters.setNamespace(state.namespace);
    filters.setSearch(state.search);
    filters.setBrokenOnly(state.brokenOnly);
    filters.setScrubAt(state.scrubAt);
    filters.setTab(state.tab);
    if (state.drawer) filters.openDrawer(state.drawer);
    else filters.closeDrawer();
    // Re-apply expanded problem set: clear then toggle each saved kind.
    for (const kind of filters.expandedProblems) filters.toggleExpandedProblem(kind);
    for (const kind of state.expandedProblems) filters.toggleExpandedProblem(kind);
  }

  function isActive(state: UrlState): boolean {
    return (
      filters.view === state.view &&
      filters.namespace === state.namespace &&
      filters.search === state.search &&
      filters.brokenOnly === state.brokenOnly
    );
  }

  function saveCurrent() {
    if (!draftName.trim()) return;
    const next = saveView({
      id: `user:${draftName.trim()}`,
      name: draftName.trim(),
      state: { ...parseUrlState(), view: filters.view },
    });
    setViews(next);
    setDraftOpen(false);
    setDraftName("");
  }

  function removeView(id: string) {
    setViews(deleteSavedView(id));
  }

  return (
    <div className="flex flex-wrap items-center gap-1 bg-background/60 px-3 py-1 text-xs shadow-[0_1px_0_0_hsl(220_30%_85%/0.6)] dark:shadow-[0_1px_0_0_hsl(222_40%_18%/0.6)]">
      {BUILTINS.map((view) => (
        <button
          key={view.id}
          type="button"
          onClick={() => applyView(view.state)}
          className={cn(
            "rounded px-2 py-0.5 transition",
            isActive(view.state) ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted",
          )}
        >
          {view.name}
        </button>
      ))}
      <div className="mx-1 h-3 w-px bg-border" aria-hidden />
      {views.map((view) => (
        <span
          key={view.id}
          className={cn(
            "group flex items-center gap-1 rounded px-2 py-0.5 transition",
            isActive(view.state) ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted",
          )}
        >
          <button type="button" onClick={() => applyView(view.state)} className="inline-flex items-center gap-1">
            <Star className="h-3 w-3" />
            {view.name}
          </button>
          <button
            type="button"
            className="opacity-0 transition group-hover:opacity-100"
            onClick={() => removeView(view.id)}
            aria-label={`Delete saved view ${view.name}`}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </span>
      ))}
      {draftOpen ? (
        <span className="inline-flex items-center gap-1">
          <Input
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder="view name"
            className="h-6 text-xs"
            autoFocus
          />
          <Button size="sm" className="h-6 px-2" onClick={saveCurrent}>
            save
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setDraftOpen(false)}>
            cancel
          </Button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setDraftOpen(true)}
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-muted-foreground hover:bg-muted"
        >
          <Plus className="h-3 w-3" />
          save current
        </button>
      )}
    </div>
  );
}
