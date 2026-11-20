"""Browser smoke test: desktop keyboard + emulated phone touch (nipplejs stick and hold buttons).
Needs `npm run build && npm run preview` running. Run: python scripts/smoke.py [out_dir] [tier]
Asserts the controls move the ship and the pause dialog opens/closes; writes screenshots.
Software GL runs at a few fps, so every check polls (wait_for_function) instead of sleeping."""
import sys
from playwright.sync_api import sync_playwright

out = sys.argv[1] if len(sys.argv) > 1 else '.'
URL = f"http://localhost:5180/thrust-force/?tier={sys.argv[2] if len(sys.argv) > 2 else 'high'}"
SHIP = 'window.__game && window.__game.ship'


def until(page, cond, what, timeout=20000):
    try:
        page.wait_for_function(cond, timeout=timeout)
    except Exception:
        raise AssertionError(f'{what}: {page.evaluate("JSON.stringify(window.__game && {...window.__game.ship, phase: window.__game.phase})")}')


with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    errors = []

    # Desktop: keyboard.
    pg = b.new_page(viewport={'width': 1280, 'height': 720})
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(URL)
    pg.wait_for_selector('#boot.ready', timeout=60000)
    pg.wait_for_timeout(500)
    pg.screenshot(path=f'{out}/title.png')
    pg.keyboard.press('Enter')
    until(pg, SHIP, 'game did not start')
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
    print('desktop ok')

    # Phone: touch stick + buttons.
    ctx = b.new_context(viewport={'width': 412, 'height': 860}, is_mobile=True, has_touch=True, device_scale_factor=2)
    m = ctx.new_page()
    m.on('pageerror', lambda e: errors.append(str(e)))
    m.goto(URL)
    m.wait_for_selector('#boot.ready', timeout=60000)
    m.wait_for_timeout(500)
    m.screenshot(path=f'{out}/mobile-title.png')
    m.tap('#boot')
    until(m, SHIP, 'game did not start')
    cdp = ctx.new_cdp_session(m)
    touch = lambda t, pts: cdp.send('Input.dispatchTouchEvent', {'type': t, 'touchPoints': pts})
    # Stick dragged right -> nose turns right (angle goes negative), no thrust below 75% push.
    touch('touchStart', [{'x': 100, 'y': 600, 'id': 1}])
    for i in range(1, 8):
        touch('touchMove', [{'x': 100 + i * 4, 'y': 600, 'id': 1}])
    until(m, 'window.__game.ship.a < -0.3', 'stick steer')
    m.screenshot(path=f'{out}/mobile-stick.png')
    # Pushed fully -> thrust.
    touch('touchMove', [{'x': 100, 'y': 520, 'id': 1}])
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
    print('mobile ok')

    assert not errors, errors
    print('smoke: ok')
    b.close()
