// The control ids (docs/analytics.md): id -> which apps tag it ("w" the site, "t" the TV app).
// test/tel-contract.test.js reads the sources and fails when this list and the tags
// (`data-ui="…"` / `uiHit("…")` on the site, `uiId="…"` on the TV) disagree.
"use strict";
module.exports = {
  // actions
  "actions.pick": "tp",
  // browse
  "browse.category.pick": "wtp",
  "browse.chip.pick": "w",
  "browse.filter.clear": "wp",
  "browse.genre.open": "w",
  "browse.loadmore": "w",
  "browse.option.pick": "w",
  "browse.retry": "tp",
  "browse.sort.open": "w",
  "browse.surprise": "wtp",
  "browse.unwatched": "wtp",
  // card
  "card.open": "wtp",
  "card.remove": "w",
  "card.hh.add": "w", // household recommendations: the "+" on a recommended card
  // detail
  "detail.download.device": "w",
  "detail.episode.download": "w",
  "detail.episode.offline": "w",
  "detail.episode.play": "wtp",
  "detail.episode.replace": "wt",
  "detail.episode.playontv": "w", // [phone-remote]
  "detail.episode.watched": "w",
  "detail.follow": "wtp",
  "detail.hh.dismiss": "wtp", // "Not for me" on a recommended title
  "detail.mylist": "wtp",
  "detail.offline": "w",
  "detail.offline.season": "w",
  "detail.offline.seasonall": "w",
  "detail.play": "wtp",
  "detail.replace": "wtp",
  "detail.playontv": "w", // [phone-remote]
  "detail.recommend": "wtp",
  "detail.restart": "wtp",
  "detail.rollagain": "w",
  "detail.save": "w",
  "detail.season.open": "w",
  "detail.season.pick": "tp",
  "detail.season.watched": "tp",
  "detail.similar": "t",
  "detail.source.download": "wtp",
  "detail.source.pick": "t",
  "detail.source.play": "wtp",
  "detail.sources": "wtp",
  "detail.sources.fold": "w",
  "detail.sources.more": "w",
  "detail.sources.retry": "w",
  "detail.synopsis.more": "w",
  "detail.trailer": "wtp",
  "detail.trailer.close": "w",
  "detail.trailer.pick": "w",
  "detail.watched": "wtp",
  "detail.xray": "wtp",
  // downloadpicker
  "downloadpicker.confirm": "w",
  // downloads
  "downloads.cancel": "w",
  "downloads.open": "w",
  "downloads.play": "w",
  "downloads.remove": "w",
  "downloads.retry": "w",
  "downloads.row": "tp",
  // home
  "home.hero.details": "wtp",
  "home.hero.mute": "wt",
  "home.hero.party": "t",
  "home.hero.pick": "w",
  "home.hero.play": "wtp",
  "home.retry": "wtp",
  "home.hh.all": "wt", // "Show all recommended"
  "home.switchprofile": "t",
  // mylist
  "mylist.filter": "tp",
  // nav
  "nav.ai": "wt",
  "nav.downloads": "w",
  "nav.getapps": "w", // the profile menu's "Get the apps" (/install)
  "nav.home": "wtp",
  "nav.movies": "wtp",
  "nav.mylist": "wtp",
  "nav.new": "w",
  "nav.profile": "wtp",
  "nav.remote": "w", // [phone-remote]
  "nav.saved": "w",
  "nav.search": "wtp",
  "nav.settings": "wtp",
  "nav.shows": "wtp",
  // newpassword
  "newpassword.signout": "tp",
  "newpassword.submit": "tp",
  // party
  "party.join": "tp",
  // peek
  "peek.close": "w",
  "peek.hh.dismiss": "wt",
  "peek.recommend": "wt",
  "peek.details": "wt",
  "peek.mylist": "wt",
  "peek.play": "wt",
  "peek.playontv": "w", // [phone-remote]
  "peek.remove": "w",
  // pick
  "pick.example": "wt",
  "pick.go": "wt",
  "pick.option": "wt",
  "pick.retry": "t",
  "pick.unfold": "t",
  // picker
  "picker.open": "t",
  "picker.pick": "t",
  // player
  "player.airplay": "w",
  "player.audio.dialogue": "wtp",
  "player.audio.night": "wtp",
  "player.audio.pick": "wtp",
  "player.autoplay": "tp",
  "player.back": "tp",
  "player.fullscreen": "w",
  "player.mute": "wtp",
  "player.next": "wtp",
  "player.party": "wtp",
  "player.party.handover": "wtp",
  "player.party.react": "wtp",
  "player.party.share": "wp",
  "player.party.start": "wtp",
  "player.party.tapjoin": "w",
  "player.pip": "w",
  "player.playpause": "wtp",
  "player.playontv": "w", // [phone-remote]
  "player.quality.pick": "w",
  "player.recommend": "w", // a film's credits card
  "player.replace": "wtp",
  "player.retry": "wtp",
  "player.scrub": "wtp",
  "player.seek.back": "wtp",
  "player.seek.fwd": "wtp",
  "player.settings.open": "wtp",
  "player.skipintro": "wtp",
  "player.slowstart.lower": "tp",
  "player.slowstart.wait": "tp",
  "player.speed.open": "wtp",
  "player.speed.pick": "wtp",
  "player.stall.lower": "tp",
  "player.stall.retry": "tp",
  "player.startover": "wtp",
  "player.stillwatching.done": "wtp",
  "player.stillwatching.keep": "wtp",
  "player.subtitles.open": "wtp",
  "player.subtitles.pick": "wtp",
  "player.subtitles.resync": "wtp",
  "player.subtitles.style": "wtp",
  "player.subtitles.undo": "w",
  "player.upnext.dismiss": "wtp",
  "player.upnext.play": "wtp",
  "player.xray": "wtp",
  // profile
  "profile.add": "w",
  "profile.gate.close": "w",
  "profile.pick": "wtp",
  "profile.pin.submit": "tp",
  "profile.save": "w",
  "profile.unlock": "wtp",
  // household (the "Show all recommended" page)
  "household.filter": "wt",
  "household.tab": "wt",
  // rating
  "rating.star": "wp",
  // remote (the phone as a remote, #/remote) [phone-remote]
  "remote.audio": "w",
  "remote.back": "w",
  "remote.close": "w",
  "remote.device.open": "w",
  "remote.device.pick": "w",
  "remote.dpad": "w",
  "remote.home": "w",
  "remote.more": "w",
  "remote.mute": "w",
  "remote.next": "w",
  "remote.padmode": "w",
  "remote.play": "w",
  "remote.playpause": "w",
  "remote.rename": "w",
  "remote.seek": "w",
  "remote.sheet.pick": "w",
  "remote.skip": "w",
  "remote.stop": "w",
  "remote.subdelay": "w",
  "remote.subtitles": "w",
  "remote.view": "w",
  "remote.volume": "w",
  // recommend (the Recommend sheet)
  "recommend.close": "wtp",
  "recommend.person": "wt",
  "recommend.send": "wtp",
  // report
  "report.send": "wtp",
  // replace ("Problem with this copy? → Get another version")
  "replace.cancel": "wtp",
  "replace.early": "tp", // "Download it anyway" on a pre-release copy (the site asks with its shared confirm sheet)
  "replace.pick": "wtp",
  "replace.reason": "wtp",
  // row
  "row.arrow": "w",
  // saved
  "saved.play": "w",
  "saved.remove": "w",
  // search
  "search.clear": "wp",
  "search.recent.pick": "wtp",
  "search.retry": "wtp",
  "search.suggestion.pick": "wtp",
  "search.voice": "wtp",
  "search.voice.lang": "wtp",
  // settings
  "settings.accent": "w",
  "settings.audio.dialogue": "t",
  "settings.audio.night": "t",
  "settings.autoplay": "tp",
  "settings.av.fps": "t", // Match frame rate (TV round 2026-10-19; the site shows it under "On the TV" with settings.toggle)
  "settings.av.surround": "t", // Surround sound
  "settings.done": "w",
  "settings.downloads": "tp",
  "settings.genre": "tp",
  "settings.hh.mute": "wtp", // Recommendations: Mute / Muted
  "settings.hh.sent": "tp", // Recommendations: What you sent (the site's is settings.link)
  "settings.hh.toggle": "tp", // Recommendations from the household (the site's is settings.toggle)
  "settings.link": "w",
  "settings.look": "w",
  "settings.notices": "t",
  "settings.party": "tp",
  "settings.report": "tp",
  "settings.rows.hide": "w",
  "settings.signout": "tp",
  "settings.taste": "t",
  "settings.subs.auto": "tp",
  "settings.subs.bg": "t",
  "settings.subs.color": "t",
  "settings.subs.lang": "tp",
  "settings.subs.opacity": "t",
  "settings.subs.pos": "t",
  "settings.subs.size": "t",
  "settings.subs.weight": "t",
  "settings.theme": "w",
  "settings.toggle": "w",
  "settings.trailers": "t",
  "settings.tvname": "t", // [phone-remote]
  "settings.tvname.pick": "t", // [phone-remote]
  "settings.update": "tp",
  "settings.usagestats": "tp",
  "settings.whatsnew": "t",
  // taste (the swipe picker, #/taste)
  "taste.back": "w",
  "taste.done": "wt",
  "taste.edit": "w",
  "taste.key": "w",
  "taste.love": "wt",
  "taste.more": "wt",
  "taste.nope": "wt",
  "taste.skip": "wt",
  "taste.swipe": "w",
  "taste.undo": "wt",
  "taste.unnope": "w",
  // signin
  "signin.getapps": "w", // "Get the apps" at the foot of the sign-in / request-access card
  "signin.mode.google": "t",
  "signin.mode.qr": "tp",
  "signin.mode.typed": "tp",
  "signin.request": "t",
  "signin.submit": "tp",
  // state
  "state.action": "t",
  // update
  "update.install": "tp",
  "update.later": "tp",
  "update.restart": "t",
  "update.retry": "t",
  // whatsnew
  "whatsnew.go": "wt",
  "whatsnew.log": "t",
  // xray
  "xray.more": "w",
  // phone — the Android phone app's own controls (tv-native/src/phone)
  "phone.browse.genre": "p", // Browse: the genre chip
  "phone.detail.episodes": "p", // a show's page: All episodes
  "phone.detail.playon": "p", // a title's page: Play on TV
  "phone.detail.share": "p", // a title's page: Share
  "phone.episode.more": "p", // a show's episode card: its round corner button (the choices)
  "phone.home.remove": "p", // the x on a Continue Watching card
  "phone.menu.apps": "p", // the profile menu: Get the apps (/install)
  "phone.menu.downloads": "p", // the profile menu: Downloads
  "phone.menu.party": "p", // the profile menu: Join a watch party
  "phone.menu.remote": "p", // the profile menu: Remote
  "phone.menu.report": "p", // the profile menu: Report a problem
  "phone.menu.settings": "p", // the profile menu: Settings
  "phone.menu.switch": "p", // the profile menu: Switch profile
  "phone.menu.whatsnew": "p", // the profile menu: What's new
  "phone.mylist.browse": "p", // an empty My List: Browse movies
  "phone.pair.approve": "p", // Sign in a TV: Yes — sign it in
  "phone.pair.cancel": "p", // Sign in a TV: Cancel (the code field)
  "phone.pair.continue": "p", // Sign in a TV: Continue (the code field)
  "phone.pair.done": "p", // Sign in a TV: Done / Back to Aurora
  "phone.pair.ignore": "p", // Sign in a TV: No, ignore it
  "phone.pair.retry": "p", // Sign in a TV: Try again (the server did not answer)
  "phone.pair.signin": "p", // Sign in a TV: Sign in to approve
  "phone.pair.type": "p", // Sign in a TV: Type a code (an expired one)
  "phone.peek.details": "p", // the long-press sheet: Details
  "phone.peek.recommend": "p", // the long-press sheet: Recommend
  "phone.player.fit": "p", // the player: Fit the picture / Fill the screen
  "phone.player.lock": "p", // the player: Lock the controls
  "phone.player.pip": "p", // the player: Picture in picture
  "phone.player.rotate": "p", // the player: Portrait / Landscape
  "phone.player.unlock": "p", // the player: Unlock the controls
  "phone.remote.arrow": "p", // the remote: an arrow of the pad
  "phone.remote.audio": "p", // the remote: audio track
  "phone.remote.back": "p", // the remote: Back
  "phone.remote.device": "p", // the remote: which TV
  "phone.remote.home": "p", // the remote: Home
  "phone.remote.next": "p", // the remote: next episode
  "phone.remote.ok": "p", // the remote: OK
  "phone.remote.pair": "p", // Your TVs: Sign in a TV
  "phone.remote.playpause": "p", // the remote: play / pause
  "phone.remote.seek": "p", // the remote: jump back / forward
  "phone.remote.stop": "p", // the remote: stop
  "phone.remote.subtitles": "p", // the remote: subtitles
  "phone.remote.volume": "p", // the remote: mute, volume down / up
  "phone.save.film": "p", // a film's page: save on this phone
  "phone.save.season": "p", // a show's page: save a season on this phone
  "phone.settings.pair": "p", // Settings: Sign in a TV
  "phone.settings.remote": "p", // Settings: Your TVs
  "phone.settings.whatsnew": "p", // Settings: What's new
  "phone.settings.saved": "p", // Settings: On this phone
  "phone.settings.switch": "p", // Settings: Switch profile / Sign out
  "phone.update.allow": "p", // the update: Allow in Settings (install unknown apps)
  "phone.update.done": "p", // the update: Got it (what's new, after the update)
  "phone.whatsnew.apps": "p", // What's new: every app and its changes (/install/changes)
  "phone.whatsnew.older": "p", // What's new: Show older
  "phone.whatsnew.retry": "p", // What's new: Try again
};
