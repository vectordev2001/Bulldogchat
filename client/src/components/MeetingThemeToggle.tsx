import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

// Public meeting screens render outside the chat app's provider tree, so this
// toggle drives the `.dark` class on <html> directly rather than via context.
export function ThemeToggle() {
  const [dark, setDark] = useState<boolean>(() =>
    typeof document !== "undefined"
      ? document.documentElement.classList.contains("dark")
      : false,
  );

  useEffect(() => {
    const root = document.documentElement;
    if (dark) root.classList.add("dark");
    else root.classList.remove("dark");
  }, [dark]);

  return (
    <button
      data-testid="button-theme-toggle"
      onClick={() => setDark((d) => !d)}
      aria-label="Toggle theme"
      title="Toggle theme"
      className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-foreground hover-elevate"
    >
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
