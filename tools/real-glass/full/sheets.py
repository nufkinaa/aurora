# The second real-glass pass's sheets (docs/qa/real-glass/full): today (the
# calm glass of 1.15.39) beside the full glass, each surface at its real
# size first, then enlarged.
#   python tools/real-glass/full/sheets.py <sweep.js shots> <sweep.js shots on the QA server> <out dir>
import os
import sys

shots, qa, out = sys.argv[1:4]
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.argv = [sys.argv[0], shots, shots, out]
import final3 as f3  # noqa: E402
from final import o  # noqa: E402

N = "Private test server, made-up art. Today = origin/master 1.15.39 (calm glass); new = this branch. Both stylesheets answered by the rig."
LAB = ("Today (calm glass)", "Full real glass")


def one(title, d, name, dpr, real, zoom, fname, beside=None):
    S = lambda v: os.path.join(d, f"{name}.{v}.png")
    o.save(f3.sheet(title, S("a"), S("e"), dpr, real=real, zoom=zoom, note=N, labels=LAB, beside=beside), fname)


if __name__ == "__main__":
    one("Episode cards and their side buttons - desktop", shots, "episodes.d", 2, [("The cards", (40, 280, 1400, 760))], [("One card", (40, 330, 760, 480), 2), ("The side buttons", (1180, 330, 1400, 480), 3)], "01-episodes-desktop.png")
    one("Episode cards - phone", shots, "episodes.p", 3, [("The screen", (0, 0, 390, 844))], [("A card", (0, 470, 390, 760), 2)], "02-episodes-phone.png")
    one("Search: the field (with its lens) and its suggestions - desktop", shots, "search.d", 2, [("The field and suggestions", (40, 60, 1400, 300))], [("The field's left end", (40, 60, 700, 260), 2)], "03-search-desktop.png")
    one("Search: the field (with its lens) and its suggestions - phone", shots, "search.p", 3, [("The screen", (0, 0, 390, 844))], [("The field and suggestions", (0, 60, 390, 420), 2)], "04-search-phone.png")
    one("The side menu, More (with its lens) - phone", shots, "more.p", 3, [("The screen", (0, 0, 390, 844))], [("The open edge over the page", (150, 300, 390, 700), 2), ("The chosen place", (0, 100, 300, 220), 2)], "05-more-phone.png")
    one("A confirm sheet (with its lens) - phone", shots, "sheet.p", 3, [("The screen", (0, 0, 390, 844))], [("The sheet", (0, 300, 390, 600), 2)], "06-sheet-phone.png")
    one("A confirm sheet (with its lens) - desktop", shots, "sheet.d", 2, [("The sheet", (420, 250, 1020, 650))], [("Its left end", (420, 300, 760, 560), 2)], "07-sheet-desktop.png")
    one("The profile menu - desktop", shots, "menu.d", 2, [("The menu", (1000, 0, 1440, 560))], [("The menu", (1100, 60, 1440, 420), 2)], "08-menu-desktop.png")
    one("The profile menu - phone", shots, "menu.p", 3, [("The screen", (0, 0, 390, 844))], [], "09-menu-phone.png")
    one("A toast - phone", shots, "toast.p", 3, [("The foot of the screen", (0, 600, 390, 844))], [("The toast", (0, 640, 390, 780), 2)], "10-toast-phone.png")
    one("Settings panes - desktop", shots, "settings.d", 2, [("The page", (200, 100, 1240, 800))], [("A pane's corner", (200, 150, 700, 420), 2)], "11-settings-desktop.png")
    one("Settings panes - phone", shots, "settings.p", 3, [("The screen", (0, 0, 390, 844))], [], "12-settings-phone.png")
    one("Chips and filters (Movies) - desktop", shots, "movies.d", 2, [("The top of the page", (0, 90, 1440, 330))], [("The chips", (40, 120, 900, 300), 2)], "13-chips-desktop.png")
    one("A film's page: the rating pane - desktop", shots, "title.d", 2, [("The page", (0, 60, 1440, 800))], [], "14-title-desktop.png")
    one("What's new - desktop", shots, "new.d", 2, [("The page", (100, 90, 1340, 700))], [], "15-new-desktop.png")
    one("Calendar, month - desktop", qa, "calendar.d", 2, [("The page", (0, 60, 1440, 900))], [("Days and the day's pane", (40, 300, 1000, 640), 2)], "16-calendar-month-desktop.png")
    one("Calendar, month - phone", qa, "calendar.p", 3, [("The screen", (0, 0, 390, 844))], [("The days", (0, 200, 390, 520), 2)], "17-calendar-month-phone.png")
    one("Calendar, list - desktop", qa, "calendar-list.d", 2, [("The page", (0, 60, 1440, 900))], [], "18-calendar-list-desktop.png")
    one("Calendar, list - phone", qa, "calendar-list.p", 3, [("The screen", (0, 0, 390, 844))], [], "19-calendar-list-phone.png")
    one("Downloads (a long list) - desktop", qa, "downloads.d", 2, [("The page", (0, 60, 1440, 900))], [("Two rows", (40, 280, 760, 460), 2)], "20-downloads-desktop.png")
    one("Downloads (a long list) - phone", qa, "downloads.p", 3, [("The screen", (0, 0, 390, 844))], [], "21-downloads-phone.png")
