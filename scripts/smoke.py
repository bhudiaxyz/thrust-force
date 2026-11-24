"""Browser smoke test: menus, desktop keyboard, planet summary, and emulated phone touch.
Needs `npm run build && npm run preview` running. Run: python scripts/smoke.py [out_dir] [tier]
Desktop: Options and Planet select sheets, start a planet, intro card, thrust / rotate / fire,
pause + idle + resume, the cleared-planet summary and Next planet, pause → Main menu.
Phone: menu tap, nipplejs stick (steer, full push → thrust), hold buttons.
A save with 3 planets cleared and the tutorial seen is preloaded, so Continue is offered.
Software GL runs at a few fps, so every check polls (wait_for_function) instead of sleeping."""
import sys
from playwright.sync_api import sync_playwright

out = sys.argv[1] if len(sys.argv) > 1 else '.'
URL = f"http://localhost:5180/thrust-force/?tier={sys.argv[2] if len(sys.argv) > 2 else 'high'}"
SHIP = 'window.__game && window.__game.ship'
SAVE = """localStorage.setItem('tf-save', JSON.stringify({ cleared: 3, seenHowto: true, stars: { 1: 3, 2: 1, 3: 2 } }))"""


def until(page, cond, what, timeout=20000):
    try:
        page.wait_for_function(cond, timeout=timeout)
    except Exception:
        raise AssertionError(f'{what}: {page.evaluate("JSON.stringify(window.__game && {...window.__game.ship, phase: window.__game.phase})")}')


with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    errors = []

    # Desktop: keyboard.
    dctx = b.new_context(viewport={'width': 1280, 'height': 720})
    dctx.add_init_script(SAVE)
    pg = dctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(URL)
    pg.wait_for_selector('#boot.ready .menu-btn', timeout=180000)
    pg.wait_for_timeout(500)
    pg.screenshot(path=f'{out}/title.png')
    assert 'Continue' in pg.text_content('.ls-menu'), 'Continue should be offered'
    # Options sheet, then back.
    pg.click('.ls-menu .menu-btn:has-text("Options")')
    pg.wait_for_selector('#sheet.open', timeout=5000)
    pg.screenshot(path=f'{out}/options.png')
    pg.keyboard.press('Escape')
    pg.wait_for_selector('#sheet.open', state='hidden', timeout=5000)
    # Planet select → planet 2.
    pg.click('.ls-menu .menu-btn:has-text("Planet select")')
    pg.wait_for_selector('#sheet.open .planet-btn', timeout=5000)
    assert pg.locator('.planet-btn').count() == 4, 'cleared 3 → planets 1..4 selectable'
    pg.screenshot(path=f'{out}/planet-select.png')
    pg.click('.planet-btn >> nth=1')
    until(pg, 'window.__game && window.__game.levelNo === 2', 'planet select should start planet 2')
    pg.wait_for_selector('#intro.show', timeout=20000)
    pg.screenshot(path=f'{out}/intro.png')
    pg.keyboard.down('ArrowUp')
    until(pg, 'window.__game.thrusting && window.__game.ship.vy > 0', 'thrust')
    pg.keyboard.up('ArrowUp')
    pg.keyboard.down('ArrowLeft')
    until(pg, 'window.__game.ship.a > 0.4', 'rotate left')
    pg.keyboard.up('ArrowLeft')
    pg.keyboard.down('Space')
    until(pg, 'window.__game.bullets.some(b => !b.enemy)', 'fire')
    pg.keyboard.up('Space')
    pg.screenshot(path=f'{out}/desktop.png')
    pg.keyboard.press('Escape')
    pg.wait_for_selector('#pause.open', timeout=5000)
    pg.screenshot(path=f'{out}/pause.png')
    until(pg, '!window.__running', 'loop should idle while paused')
    pg.keyboard.press('Escape')
    pg.wait_for_selector('#pause.open', state='hidden', timeout=5000)
    until(pg, 'window.__running', 'loop should wake on resume')
    # Clear the planet: tow the pod out of the sky → summary → Next planet.
    pg.evaluate("""(() => { const g = window.__game, lv = g.level; lv.turrets.length = 0;
        Object.assign(g.pod, { attached: true, len: 3, x: lv.w / 2, y: lv.exitY - 2.5, vx: 0, vy: 0 });
        Object.assign(g.ship, { x: lv.w / 2, y: lv.exitY + 0.5, vx: 0, vy: 0, a: 0 }); })()""")
    pg.wait_for_selector('#sheet.open .summary', timeout=30000)
    pg.screenshot(path=f'{out}/summary.png')
    pg.click('#sheet .sheet-actions .primary')
    until(pg, 'window.__game.levelNo === 3', 'Next planet should load planet 3')
    # Pause → Main menu.
    pg.keyboard.press('Escape')
    pg.wait_for_selector('#pause.open', timeout=5000)
    pg.click('#pause-menu')
    pg.wait_for_selector('#boot.ready .menu-btn', timeout=10000)
    until(pg, '!window.__game', 'main menu should end the run')
    print('desktop ok')

    # Phone: touch stick + buttons.
    ctx = b.new_context(viewport={'width': 412, 'height': 860}, is_mobile=True, has_touch=True, device_scale_factor=2)
    ctx.add_init_script(SAVE)
    m = ctx.new_page()
    m.on('pageerror', lambda e: errors.append(str(e)))
    m.goto(URL)
    m.wait_for_selector('#boot.ready .menu-btn', timeout=180000)
    m.wait_for_timeout(500)
    m.screenshot(path=f'{out}/mobile-title.png')
    # Every menu by touch: Options → Done, How to play → Next, Next, Let's fly, Planet select → 1.
    m.tap('.ls-menu .menu-btn:has-text("Options")')
    m.wait_for_selector('#sheet.open .options', timeout=5000)
    m.screenshot(path=f'{out}/mobile-options.png')
    m.tap('#sheet .sheet-actions .primary')
    m.wait_for_selector('#sheet.open', state='hidden', timeout=5000)
    m.tap('.ls-menu .menu-btn:has-text("How to play")')
    for _ in range(3):
        m.wait_for_selector('#sheet.open .howto', timeout=5000)
        m.tap('#sheet .sheet-actions .primary')
    m.wait_for_selector('#sheet.open', state='hidden', timeout=5000)
    m.tap('.ls-menu .menu-btn:has-text("Planet select")')
    m.wait_for_selector('#sheet.open .planet-btn', timeout=5000)
    m.screenshot(path=f'{out}/mobile-planets.png')
    m.tap('.planet-btn >> nth=0')
    until(m, SHIP, 'game did not start')
    cdp = ctx.new_cdp_session(m)
    touch = lambda t, pts: cdp.send('Input.dispatchTouchEvent', {'type': t, 'touchPoints': pts})
    # Stick dragged right -> nose turns right (angle goes negative), no thrust below 75% push.
    # The joypad is fixed in the bottom-left corner: start at its centre.
    jx, jy = m.evaluate("(() => { const r = document.getElementById('joy').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")
    touch('touchStart', [{'x': jx, 'y': jy, 'id': 1}])
    for i in range(1, 8):
        touch('touchMove', [{'x': jx + i * 4, 'y': jy, 'id': 1}])
    until(m, 'window.__game.ship.a < -0.3', 'stick steer')
    m.screenshot(path=f'{out}/mobile-stick.png')
    # Pushed fully -> thrust.
    touch('touchMove', [{'x': jx, 'y': jy - 70, 'id': 1}])
    until(m, 'window.__game.thrusting', 'stick thrust')
    touch('touchEnd', [])
    until(m, '!window.__game.thrusting', 'stick release')
    # Hold buttons.
    for k, flag in (('shield', 'shielding'), ('thrust', 'thrusting')):
        box = m.locator(f'[data-k={k}]').bounding_box()
        pt = {'x': box['x'] + box['width'] / 2, 'y': box['y'] + box['height'] / 2, 'id': 2}
        touch('touchStart', [pt])
        until(m, f'window.__game.{flag} || window.__game.phase !== "play"', f'{k} press')
        touch('touchEnd', [])
        until(m, f'!window.__game.{flag}', f'{k} release')
    m.screenshot(path=f'{out}/mobile.png')
    # Touch pause → Main menu.
    m.tap('#t-pause')
    m.wait_for_selector('#pause.open', timeout=5000)
    m.screenshot(path=f'{out}/mobile-pause.png')
    m.tap('#pause-menu')
    m.wait_for_selector('#boot.ready .menu-btn', timeout=10000)
    print('mobile ok')

    # Landscape phone: every main-menu item must be on screen and tappable.
    lctx = b.new_context(viewport={'width': 860, 'height': 412}, is_mobile=True, has_touch=True)
    lctx.add_init_script(SAVE)
    l = lctx.new_page()
    l.on('pageerror', lambda e: errors.append(str(e)))
    l.goto(URL)
    l.wait_for_selector('#boot.ready .menu-btn', timeout=180000)
    l.wait_for_timeout(500)
    l.screenshot(path=f'{out}/landscape-menu.png')
    for i in range(l.locator('.ls-menu .menu-btn').count()):
        box = l.locator('.ls-menu .menu-btn').nth(i).bounding_box()
        assert box and box['y'] >= 0 and box['y'] + box['height'] <= 412, f'menu item {i} off screen: {box}'
    l.tap('.ls-menu .menu-btn:has-text("Options")')
    l.wait_for_selector('#sheet.open .options', timeout=5000)
    l.screenshot(path=f'{out}/landscape-options.png')
    l.tap('#sheet .sheet-actions .primary')
    l.wait_for_selector('#sheet.open', state='hidden', timeout=5000)
    print('landscape ok')

    assert not errors, errors
    print('smoke: ok')
    b.close()
