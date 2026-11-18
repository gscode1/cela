import { useId, useState } from "react";
import { cn } from "@/lib/utils";
import { filterOptions } from "@/lib/models";
import type { PickOption } from "@/lib/models";

/**
 * A searchable single choice that lists at most a screenful of matches ("N more — keep typing" for the rest). The
 * WAI-ARIA combobox pattern with a list popup: arrows move, Enter picks, Escape closes. `display` is what the field
 * shows while it is not being typed in.
 */
export function Combobox({
  id,
  options,
  display,
  placeholder,
  ariaLabel,
  onPick,
}: {
  id: string;
  options: readonly PickOption[];
  display: string;
  placeholder?: string;
  ariaLabel?: string;
  onPick: (key: string) => void;
}) {
  const listId = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const { shown, more } = filterOptions(options, query ?? "");
  const activeId = open && shown[active] !== undefined ? `${listId}-${String(active)}` : undefined;
  const close = (): void => {
    setOpen(false);
    setQuery(null);
    setActive(0);
  };
  const pick = (key: string): void => {
    close();
    onPick(key);
  };
  return (
    <div className="relative">
      <input
        id={id}
        role="combobox"
        type="text"
        autoComplete="off"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        placeholder={placeholder}
        value={query ?? display}
        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onFocus={(event) => {
          setOpen(true);
          if (query === null) event.target.select();
        }}
        onBlur={close}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive(Math.min(active + 1, shown.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive(Math.max(active - 1, 0));
          } else if (event.key === "Enter" && open && shown[active] !== undefined) {
            event.preventDefault();
            pick(shown[active].key);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            close();
          }
        }}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-background p-1 text-sm text-foreground shadow-md"
        >
          {shown.map((option, index) => (
            <li
              key={option.key}
              id={`${listId}-${String(index)}`}
              role="option"
              aria-selected={index === active}
              className={cn(
                "cursor-pointer rounded-sm px-2 py-1.5",
                index === active && "bg-muted text-foreground",
              )}
              onMouseEnter={() => {
                setActive(index);
              }}
              // mousedown, not click: the input would blur and close the list first.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(option.key);
              }}
            >
              {/* A row is the model's key alone, short at any provider size; the search still matches the name. */}
              <span className="break-all">{option.key === "" ? option.label : option.key}</span>
            </li>
          ))}
          {shown.length === 0 && <li className="px-2 py-1.5 text-muted-foreground">No match</li>}
          {more > 0 && (
            <li role="presentation" className="px-2 py-1.5 text-xs text-muted-foreground">
              {more} more {"—"} keep typing
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
