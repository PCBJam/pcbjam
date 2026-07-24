import { Moon, Sun } from "lucide-react";
import { setTheme, useThemeValue } from "@/lib/theme";
import { Button } from "@/components/ui/button";

/** Sun/moon theme toggle (comments-ux 0002): flips `<html>.dark` + storage;
 *  theme.ts subscribers (incl. the F4 canvas bridge) follow. */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useThemeValue();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <Button
      variant="ghost"
      size="icon"
      data-testid="theme-toggle"
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
      className={className}
      onClick={() => setTheme(next)}
    >
      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </Button>
  );
}
