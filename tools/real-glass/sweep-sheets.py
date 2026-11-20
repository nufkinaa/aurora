# The sweep's sheets: today beside the new stylesheet, each surface at its
# real size first, then enlarged.
#   python tools/real-glass/sweep-sheets.py <sweep.js shots> <calendar a dir> <calendar e dir> <out dir>
import os
import sys

shots, cal_a, cal_e, out = sys.argv[1:5]
sys.argv = [sys.argv[0], shots, shots, out]
import final3 as f3  # noqa: E402
from final import o  # noqa: E402

S = lambda name, v: os.path.join(shots, f"{name}.{v}.png")
N = "Private test server, made-up art. Both stylesheets answered by the rig."


def one(title, name, dpr, real, zoom, fname):
    o.save(f3.sheet(title, S(name, "a"), S(name, "e"), dpr, real=real, zoom=zoom, note=N), fname)


if __name__ == "__main__":
    one("Episode cards and their side buttons - desktop", "episodes.d", 2, [("The cards", (40, 300, 1400, 700))], [("One card", (40, 300, 1000, 480), 2)], "01-episodes-desktop.png")
    one("Episode cards - phone", "episodes.p", 3, [("The screen", (0, 0, 390, 844))], [("The cards", (0, 300, 390, 700), 2)], "02-episodes-phone.png")
    one("Search: the field and its suggestions - desktop", "search.d", 2, [("The field and suggestions", (150, 90, 1300, 320))], [("The field's left end", (150, 90, 800, 320), 2)], "03-search-desktop.png")
    one("Search - phone", "search.p", 3, [("The screen", (0, 0, 390, 844))], [("The field", (0, 60, 390, 300), 2)], "04-search-phone.png")
    one("Chips and filters (Movies) - desktop", "movies.d", 2, [("The top of the page", (0, 90, 1440, 330))], [("The chips", (40, 120, 900, 300), 2)], "05-chips-desktop.png")
    one("Settings panes - desktop", "settings.d", 2, [("The page", (200, 100, 1240, 800))], [], "06-settings-desktop.png")
    one("Downloads - desktop", "downloads.d", 2, [("The page", (0, 90, 1440, 700))], [], "07-downloads-desktop.png")
    one("The profile menu - desktop", "menu.d", 2, [("The menu", (1000, 0, 1440, 520))], [("The menu", (1100, 60, 1440, 400), 2)], "08-menu-desktop.png")
    one("A toast and a confirm sheet - phone", "toast.p", 3, [("The toast", (0, 600, 390, 844))], [("The toast", (0, 640, 390, 780), 2)], "09-toast-phone.png")
    one("A confirm sheet - phone", "sheet.p", 3, [("The screen", (0, 0, 390, 844))], [], "10-sheet-phone.png")
    one("A film's page: the rating pane - desktop", "title.d", 2, [("The page", (0, 250, 1440, 800))], [], "11-title-desktop.png")
    one("What's new - desktop", "new.d", 2, [("The page", (100, 90, 1340, 700))], [], "12-new-desktop.png")
    # the Calendar: the tests' own photographs (showcase seed), 1440 at 1x and phones at 2x
    C = lambda d, n: os.path.join(d, n + ".png")
    f3.REAL = ""
    o.save(f3.sheet("Calendar, month - desktop 1440", C(cal_a, "1440-glass"), C(cal_e, "1440-glass"), 1, real=[("The page", (0, 60, 1440, 640))], zoom=[("Days and the day's pane", (30, 180, 990, 560), 2)], note="The Calendar tests' showcase data."), "13-calendar-month-desktop.png")
    o.save(f3.sheet("Calendar, month - phone 414", C(cal_a, "414-glass"), C(cal_e, "414-glass"), 2, real=[("The screen", (0, 0, 414, 896))], zoom=[("The days", (0, 180, 414, 560), 2)], note="The Calendar tests' showcase data."), "14-calendar-month-phone.png")
    o.save(f3.sheet("Calendar, list - desktop 1280", C(cal_a, "desktop-glass-coming-up"), C(cal_e, "desktop-glass-coming-up"), 1, real=[("The page", (0, 60, 1280, 720))], zoom=[], note="The Calendar tests' data."), "15-calendar-list-desktop.png")
    o.save(f3.sheet("Calendar, list - phone 320", C(cal_a, "320-glass-coming-up"), C(cal_e, "320-glass-coming-up"), 2, real=[("The screen", (0, 0, 320, 640))], zoom=[], note="The Calendar tests' data."), "16-calendar-list-phone.png")
