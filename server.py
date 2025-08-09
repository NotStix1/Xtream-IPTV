#!/usr/bin/env python3
"""
IPTV Web App (Aurora build)
- No external Python deps: uses http.server + sqlite3
- Email/password auth, profiles, favourites, recently watched
- Xtream Codes (player_api.php) for categories/streams
- Info endpoints: get_vod_info / get_series_info
- Series playback via episode IDs
- FFmpeg "Compatibility Mode" for VOD: /compat/vod/<stream_id>?ext=mp4
"""
import os
import re
import json
import sqlite3
import secrets
import urllib.request
import urllib.parse
import subprocess
import shutil
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'app.db')
TEMPLATES_DIR = os.path.join(BASE_DIR, 'templates')
STATIC_DIR = os.path.join(BASE_DIR, 'static')
CACHE_DIR = os.path.join(BASE_DIR, 'cache')
 

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            token TEXT
        );
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS iptv_credentials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            server_url TEXT,
            iptv_username TEXT,
            iptv_password TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS favourites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id INTEGER NOT NULL,
            content_type TEXT,
            item_id TEXT,
            title TEXT,
            thumbnail TEXT,
            UNIQUE(profile_id, content_type, item_id),
            FOREIGN KEY(profile_id) REFERENCES profiles(id)
        );
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS recently_watched (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id INTEGER NOT NULL,
            content_type TEXT,
            item_id TEXT,
            title TEXT,
            thumbnail TEXT,
            watched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(profile_id) REFERENCES profiles(id)
        );
        """
    )
    conn.commit()
    conn.close()

def db_connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

class IPTVRequestHandler(SimpleHTTPRequestHandler):
    # Route regex
    re_categories   = re.compile(r'^/categories/(?P<type>[a-zA-Z]+)$')
    re_streams      = re.compile(r'^/streams/(?P<type>[a-zA-Z]+)/(?P<catid>\d+)$')
    re_stream_url   = re.compile(r'^/stream_url/(?P<type>[a-zA-Z]+)/(?P<sid>\d+)$')
    re_info         = re.compile(r'^/info/(?P<itype>vod|series)/(?P<itemid>\d+)$')
    re_profile      = re.compile(r'^/profiles/(?P<pid>\d+)$')
    re_search       = re.compile(r'^/search$')
    re_profile_fav  = re.compile(r'^/profiles/(?P<pid>\d+)/favourites(?:/(?P<fid>\d+))?$')
    re_compat_vod   = re.compile(r'^/compat/vod/(?P<sid>\d+)$')
    re_compat_live  = re.compile(r'^/compat/live/(?P<sid>\d+)$')
    re_compat_series= re.compile(r'^/compat/series/(?P<sid>\d+)$')
    # IPTV settings helpers
    re_iptv_credentials = re.compile(r'^/iptv/credentials$')
    re_iptv_refresh     = re.compile(r'^/iptv/refresh$')
    # Proxies / helpers for VOD
    re_proxy_vod    = re.compile(r'^/proxy/vod/(?P<sid>\d+)$')
    re_hls_check_vod= re.compile(r'^/hls/check/vod/(?P<sid>\d+)$')
    

    # --- Helpers
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def _send_file(self, path, content_type=None):
        try:
            with open(path, 'rb') as f:
                data = f.read()
        except Exception:
            self.send_error(404, 'Not Found')
            return
        if not content_type:
            ext = os.path.splitext(path)[1].lower()
            if ext in ('.html', '.htm'):
                content_type = 'text/html'
            elif ext == '.css':
                content_type = 'text/css'
            elif ext == '.js':
                content_type = 'application/javascript'
            elif ext in ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'):
                content_type = 'image/' + ext[1:]
            else:
                content_type = 'application/octet-stream'
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', len(data))
        self.end_headers()
        self.wfile.write(data)

    def _ok_json(self, obj):
        data = json.dumps(obj).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(data))
        self.end_headers()
        self.wfile.write(data)

    def _err(self, status, message):
        self.send_response(status)
        self.end_headers()
        self.wfile.write(json.dumps({'error': message}).encode())

    def parse_auth_token(self):
        auth = self.headers.get('Authorization', '')
        parts = auth.split()
        if len(parts) == 2 and parts[0].lower() == 'bearer':
            return parts[1]
        # Fallback: allow token via query param for media elements that cannot set headers
        try:
            q = parse_qs(urlparse(self.path).query)
            t = q.get('token', [None])[0]
            if t:
                return t
        except Exception:
            pass
        return None

    def authenticate(self):
        token = self.parse_auth_token()
        if not token:
            self._err(401, 'Missing authentication token')
            return None
        conn = db_connect()
        row = conn.execute('SELECT * FROM users WHERE token=?', (token,)).fetchone()
        conn.close()
        if not row:
            self._err(401, 'Invalid or expired token')
            return None
        return row

    # --- HTTP verbs
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # Static / templates
        if path.startswith('/static/'):
            fpath = os.path.join(STATIC_DIR, path[len('/static/'):])
            return self._send_file(fpath)
        if path == '/':
            return self._send_file(os.path.join(TEMPLATES_DIR, 'index.html'))
        if path == '/home':
            return self._send_file(os.path.join(TEMPLATES_DIR, 'home.html'))
        if path == '/settings/iptv':
            return self._send_file(os.path.join(TEMPLATES_DIR, 'iptv_settings.html'))
        if path == '/player':
            return self._send_file(os.path.join(TEMPLATES_DIR, 'player.html'))
        if path == '/videoplayer':
            return self._send_file(os.path.join(TEMPLATES_DIR, 'player.html'))

        # API routes
        m = self.re_categories.match(path)
        if m: return self.handle_categories(m.group('type'))
        m = self.re_streams.match(path)
        if m: return self.handle_streams(m.group('type'), m.group('catid'))
        m = self.re_stream_url.match(path)
        if m: return self.handle_stream_url(m.group('type'), m.group('sid'))
        m = self.re_info.match(path)
        if m: return self.handle_info(m.group('itype'), m.group('itemid'))
        m = self.re_compat_vod.match(path)
        if m: return self.handle_compat_vod(m.group('sid'))
        m = self.re_compat_live.match(path)
        if m: return self.handle_compat_live(m.group('sid'))
        m = self.re_compat_series.match(path)
        if m: return self.handle_compat_series(m.group('sid'))
        if self.re_iptv_credentials.match(path):
            return self.handle_get_iptv_credentials()
        m = self.re_proxy_vod.match(path)
        if m: return self.handle_proxy_vod(m.group('sid'))
        m = self.re_hls_check_vod.match(path)
        if m: return self.handle_hls_check_vod(m.group('sid'))
        
        m = self.re_search.match(path)
        if m: return self.handle_search()

        if path == '/profiles':
            return self.handle_profiles()
        m = self.re_profile.match(path)
        if m: return self.handle_profile_detail(int(m.group('pid')))

        m = self.re_profile_fav.match(path)
        if m and m.group('fid') is None:
            return self._err(405, 'Method not allowed')

        return self.send_error(404, 'Not Found')

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length else b''
        try:
            data = json.loads(body.decode('utf-8')) if body else {}
        except Exception:
            data = {}

        if path == '/register': return self.handle_register(data)
        if path == '/login': return self.handle_login(data)
        if path == '/iptv/login': return self.handle_iptv_login(data)
        if path == '/iptv/refresh': return self.handle_iptv_refresh()
        if path == '/profiles': return self.handle_create_profile(data)

        m = self.re_profile_fav.match(path)
        if m and m.group('fid') is None:
            return self.handle_add_favourite(int(m.group('pid')), data)

        return self.send_error(404, 'Not Found')

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        m = self.re_profile.match(path)
        if m:
            return self.handle_delete_profile(int(m.group('pid')))
        m = self.re_profile_fav.match(path)
        if m and m.group('fid'):
            return self.handle_delete_favourite(int(m.group('pid')), int(m.group('fid')))
        return self.send_error(404, 'Not Found')

    # --- Handlers
    def handle_register(self, data):
        email = (data.get('email') or '').strip().lower()
        password = (data.get('password') or '').strip()
        if not email or not password:
            return self._err(400, 'Email and password are required')
        conn = db_connect()
        if conn.execute('SELECT 1 FROM users WHERE email=?', (email,)).fetchone():
            conn.close()
            return self._err(400, 'Account already exists')
        # Hash via PBKDF2 (no external deps)
        import hashlib, secrets as _se
        salt = _se.token_hex(16)
        derived = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 260000)
        password_hash = f'pbkdf2:sha256:260000${salt}${derived.hex()}'
        token = _se.token_hex(16)
        conn.execute('INSERT INTO users (email, password_hash, token) VALUES (?, ?, ?)', (email, password_hash, token))
        conn.commit()
        conn.close()
        return self._ok_json({'token': token})

    def handle_login(self, data):
        email = (data.get('email') or '').strip().lower()
        password = (data.get('password') or '').strip()
        if not email or not password:
            return self._err(400, 'Email and password are required')
        conn = db_connect()
        row = conn.execute('SELECT id, password_hash FROM users WHERE email=?', (email,)).fetchone()
        if not row:
            conn.close()
            return self._err(401, 'Invalid credentials')
        # Verify pbkdf2
        import hashlib
        try:
            method, salt, hash_hex = row['password_hash'].split('$')
            iterations = int(method.split(':')[-1])
        except Exception:
            conn.close()
            return self._err(500, 'Password hash format invalid')
        derived = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), iterations)
        if derived.hex() != hash_hex:
            conn.close()
            return self._err(401, 'Invalid credentials')
        token = secrets.token_hex(16)
        conn.execute('UPDATE users SET token=? WHERE id=?', (token, row['id']))
        conn.commit()
        conn.close()
        return self._ok_json({'token': token})

    def handle_iptv_login(self, data):
        user = self.authenticate()
        if not user: return
        server_url = (data.get('server_url') or '').strip().rstrip('/')
        u = (data.get('username') or '').strip()
        p = (data.get('password') or '').strip()
        if not server_url.startswith('http'):
            server_url = 'http://' + server_url
        if not server_url or not u or not p:
            return self._err(400, 'Server URL, username and password are required')
        # Verify against Xtream player_api.php
        try:
            query = urllib.parse.urlencode({'username': u, 'password': p})
            url = f'{server_url}/player_api.php?{query}'
            with urllib.request.urlopen(url, timeout=20) as resp:
                body = resp.read()
            data = json.loads(body.decode('utf-8'))
            if not isinstance(data, dict) or data.get('user_info', {}).get('auth') != 1:
                return self._err(400, 'Failed to verify IPTV credentials')
        except Exception as e:
            return self._err(400, f'Failed to verify IPTV credentials: {e}')
        conn = db_connect()
        have = conn.execute('SELECT id FROM iptv_credentials WHERE user_id=?', (user['id'],)).fetchone()
        if have:
            conn.execute('UPDATE iptv_credentials SET server_url=?, iptv_username=?, iptv_password=? WHERE user_id=?',
                         (server_url, u, p, user['id']))
        else:
            conn.execute('INSERT INTO iptv_credentials (user_id, server_url, iptv_username, iptv_password) VALUES (?, ?, ?, ?)',
                         (user['id'], server_url, u, p))
        conn.commit()
        conn.close()
        return self._ok_json({'message': 'IPTV credentials saved successfully'})

    def handle_get_iptv_credentials(self):
        user = self.authenticate()
        if not user:
            return
        creds = self.get_xtream_credentials(user['id'])
        if not creds:
            return self._ok_json({})
        # Never return password to client
        return self._ok_json({'server_url': creds['server_url'] or '', 'username': creds['iptv_username'] or ''})

    def handle_iptv_refresh(self):
        user = self.authenticate()
        if not user:
            return
        creds = self.get_xtream_credentials(user['id'])
        if not creds:
            return self._err(400, 'IPTV credentials not set for this user')
        try:
            query = urllib.parse.urlencode({'username': creds['iptv_username'], 'password': creds['iptv_password']})
            url = f"{creds['server_url']}/player_api.php?{query}"
            with urllib.request.urlopen(url, timeout=20) as resp:
                body = resp.read()
            data = json.loads(body.decode('utf-8'))
            ok = isinstance(data, dict) and data.get('user_info', {}).get('auth') == 1
            return self._ok_json({'ok': bool(ok)})
        except Exception as e:
            return self._err(500, f'Refresh failed: {e}')

    def handle_profiles(self):
        user = self.authenticate()
        if not user: return
        conn = db_connect()
        rows = conn.execute('SELECT id, name FROM profiles WHERE user_id=?', (user['id'],)).fetchall()
        conn.close()
        return self._ok_json([{'id': r['id'], 'name': r['name']} for r in rows])

    def handle_create_profile(self, data):
        user = self.authenticate()
        if not user: return
        name = (data.get('name') or '').strip()
        if not name: return self._err(400, 'Profile name is required')
        conn = db_connect()
        cur = conn.execute('INSERT INTO profiles (user_id, name) VALUES (?, ?)', (user['id'], name))
        conn.commit()
        pid = cur.lastrowid
        conn.close()
        return self._ok_json({'id': pid, 'name': name})

    def handle_profile_detail(self, pid):
        user = self.authenticate()
        if not user: return
        conn = db_connect()
        prof = conn.execute('SELECT * FROM profiles WHERE id=? AND user_id=?', (pid, user['id'])).fetchone()
        if not prof:
            conn.close()
            return self._err(404, 'Profile not found')
        favs = [dict(r) for r in conn.execute('SELECT id, content_type, item_id, title, thumbnail FROM favourites WHERE profile_id=?', (pid,)).fetchall()]
        recs = [dict(r) for r in conn.execute('SELECT id, content_type, item_id, title, thumbnail, watched_at FROM recently_watched WHERE profile_id=? ORDER BY watched_at DESC', (pid,)).fetchall()]
        conn.close()
        return self._ok_json({'id': prof['id'], 'name': prof['name'], 'favourites': favs, 'recently_watched': recs})

    def handle_delete_profile(self, pid):
        user = self.authenticate()
        if not user: return
        conn = db_connect()
        have = conn.execute('SELECT 1 FROM profiles WHERE id=? AND user_id=?', (pid, user['id'])).fetchone()
        if not have:
            conn.close()
            return self._err(404, 'Profile not found')
        conn.execute('DELETE FROM favourites WHERE profile_id=?', (pid,))
        conn.execute('DELETE FROM recently_watched WHERE profile_id=?', (pid,))
        conn.execute('DELETE FROM profiles WHERE id=? AND user_id=?', (pid, user['id']))
        conn.commit()
        conn.close()
        return self._ok_json({'message': 'Profile deleted'})

    def handle_add_favourite(self, pid, data):
        user = self.authenticate()
        if not user: return
        content_type = data.get('content_type'); item_id = data.get('item_id')
        title = data.get('title'); thumb = data.get('thumbnail')
        if not content_type or not item_id: return self._err(400, 'Invalid favourite data')
        conn = db_connect()
        ok = conn.execute('SELECT 1 FROM profiles WHERE id=? AND user_id=?', (pid, user['id'])).fetchone()
        if not ok:
            conn.close(); return self._err(404, 'Profile not found')
        try:
            cur = conn.execute('INSERT INTO favourites (profile_id, content_type, item_id, title, thumbnail) VALUES (?, ?, ?, ?, ?)',
                            (pid, content_type, item_id, title, thumb))
            fid = cur.lastrowid
            conn.commit()
        except sqlite3.IntegrityError:
            # already exists
            fid = conn.execute('SELECT id FROM favourites WHERE profile_id=? AND content_type=? AND item_id=?',
                               (pid, content_type, item_id)).fetchone()['id']
        conn.close()
        return self._ok_json({'id': fid})

    def handle_delete_favourite(self, pid, fid):
        user = self.authenticate()
        if not user: return
        conn = db_connect()
        ok = conn.execute('SELECT f.id FROM favourites f JOIN profiles p ON f.profile_id=p.id WHERE f.id=? AND p.id=? AND p.user_id=?',
                          (fid, pid, user['id'])).fetchone()
        if not ok:
            conn.close(); return self._err(404, 'Favourite not found')
        conn.execute('DELETE FROM favourites WHERE id=?', (fid,))
        conn.commit(); conn.close()
        return self._ok_json({'message': 'Favourite removed'})

    # Xtream helpers
    def get_xtream_credentials(self, user_id):
        conn = db_connect()
        row = conn.execute('SELECT * FROM iptv_credentials WHERE user_id=?', (user_id,)).fetchone()
        conn.close()
        return row

    def call_xtream(self, creds, action=None, extra=None):
        params = {'username': creds['iptv_username'], 'password': creds['iptv_password']}
        if action: params['action'] = action
        if extra: params.update(extra or {})
        query = urllib.parse.urlencode(params)
        url = f"{creds['server_url']}/player_api.php?{query}"
        with urllib.request.urlopen(url, timeout=30) as resp:
            body = resp.read()
        try:
            return json.loads(body.decode('utf-8'))
        except Exception:
            return []

    def _build_remote_url(self, creds, ctype, sid, ext='mp4'):
        st = (ctype or '').lower()
        e = (ext or 'mp4')
        if st == 'vod':
            return f"{creds['server_url']}/movie/{creds['iptv_username']}/{creds['iptv_password']}/{sid}.{e}"
        elif st == 'series':
            return f"{creds['server_url']}/series/{creds['iptv_username']}/{creds['iptv_password']}/{sid}.{e}"
        elif st == 'live':
            return f"{creds['server_url']}/live/{creds['iptv_username']}/{creds['iptv_password']}/{sid}.ts"
        return None

    def handle_proxy_vod(self, sid):
        user = self.authenticate()
        if not user:
            return
        creds = self.get_xtream_credentials(user['id'])
        if not creds:
            return self._err(400, 'IPTV credentials not set for this user')
        q = parse_qs(urlparse(self.path).query)
        ext = (q.get('ext', ['mp4'])[0] or 'mp4').strip()
        remote = self._build_remote_url(creds, 'vod', sid, ext)
        if not remote:
            return self._err(400, 'Bad request')
        # Forward Range if provided
        range_header = self.headers.get('Range')
        headers = {
            'User-Agent': 'Mozilla/5.0',
        }
        if range_header:
            headers['Range'] = range_header
        req = urllib.request.Request(remote, headers=headers, method='GET')
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                status = resp.status
                # Map headers
                src_ct = resp.headers.get('Content-Type') or 'video/mp4'
                src_len = resp.headers.get('Content-Length')
                src_range = resp.headers.get('Content-Range')
                accept_ranges = resp.headers.get('Accept-Ranges') or 'bytes'
                # If client asked Range but origin returned 200, pass it through; do not downgrade or strip
                self.send_response(status)
                self.send_header('Content-Type', src_ct)
                if src_len: self.send_header('Content-Length', src_len)
                if src_range: self.send_header('Content-Range', src_range)
                if accept_ranges: self.send_header('Accept-Ranges', accept_ranges)
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                # Stream body
                for chunk in iter(lambda: resp.read(64 * 1024), b''):
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except Exception as e:
            return self._err(502, f'Upstream error: {e}')

    def handle_hls_check_vod(self, sid):
        user = self.authenticate()
        if not user:
            return
        creds = self.get_xtream_credentials(user['id'])
        if not creds:
            return self._err(400, 'IPTV credentials not set for this user')
        # Try to fetch m3u8 and inspect for VOD markers
        remote = self._build_remote_url(creds, 'vod', sid, 'm3u8')
        try:
            req = urllib.request.Request(remote, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read(512 * 1024)  # up to 512KB
            text = body.decode('utf-8', errors='ignore')
            lower = text.lower()
            ok = ('#ext-x-endlist' in lower) or ('#ext-x-playlist-type:vod' in lower)
            if ok:
                return self._ok_json({'ok': True, 'url': remote})
            return self._ok_json({'ok': False})
        except Exception:
            return self._ok_json({'ok': False})

    def handle_categories(self, cat_type):
        user = self.authenticate()
        if not user: return
        creds = self.get_xtream_credentials(user['id'])
        if not creds: return self._err(400, 'IPTV credentials not set for this user')
        mapping = {'live': 'get_live_categories', 'vod': 'get_vod_categories', 'series': 'get_series_categories'}
        act = mapping.get(cat_type.lower())
        if not act: return self._err(400, 'Invalid category type')
        try:
            data = self.call_xtream(creds, act)
            return self._ok_json(data)
        except Exception as e:
            return self._err(500, f'Failed to fetch categories: {e}')

    def handle_streams(self, stream_type, catid):
        user = self.authenticate()
        if not user: return
        creds = self.get_xtream_credentials(user['id'])
        if not creds: return self._err(400, 'IPTV credentials not set for this user')
        mapping = {'live': 'get_live_streams', 'vod': 'get_vod_streams', 'series': 'get_series'}
        act = mapping.get(stream_type.lower())
        if not act: return self._err(400, 'Invalid stream type')
        try:
            data = self.call_xtream(creds, act, {'category_id': catid})
            return self._ok_json(data)
        except Exception as e:
            return self._err(500, f'Failed to fetch streams: {e}')

    def handle_stream_url(self, stream_type, sid):
        user = self.authenticate()
        if not user: return
        creds = self.get_xtream_credentials(user['id'])
        if not creds: return self._err(400, 'IPTV credentials not set for this user')
        q = parse_qs(urlparse(self.path).query)
        ext = q.get('ext', ['mp4'])[0]
        st = stream_type.lower()
        if st == 'live':
            url = f"{creds['server_url']}/live/{creds['iptv_username']}/{creds['iptv_password']}/{sid}.ts"
        elif st == 'vod':
            # Prefer MP4 containers; some providers only expose mkv/avi. Keep ext from query but map non-mp4 to mp4 for better seeking.
            if ext.lower() not in ('mp4', 'm4v', 'mov'):
                ext = 'mp4'
            url = f"{creds['server_url']}/movie/{creds['iptv_username']}/{creds['iptv_password']}/{sid}.{ext}"
        elif st == 'series':
            url = f"{creds['server_url']}/series/{creds['iptv_username']}/{creds['iptv_password']}/{sid}.{ext}"
        else:
            return self._err(400, 'Unsupported stream type')
        return self._ok_json({'url': url})

    def handle_info(self, info_type, item_id):
        user = self.authenticate()
        if not user: return
        creds = self.get_xtream_credentials(user['id'])
        if not creds: return self._err(400, 'IPTV credentials not set for this user')
        if info_type == 'vod':
            data = self.call_xtream(creds, 'get_vod_info', {'vod_id': item_id})
        else:
            data = self.call_xtream(creds, 'get_series_info', {'series_id': item_id})
        return self._ok_json(data)

    def handle_search(self):
        user = self.authenticate()
        if not user:
            return
        creds = self.get_xtream_credentials(user['id'])
        if not creds:
            return self._err(400, 'IPTV credentials not set for this user')
        q = parse_qs(urlparse(self.path).query)
        query = (q.get('q', [''])[0] or '').strip().lower()
        type_filter = (q.get('type', ['all'])[0] or 'all').lower()
        if not query:
            return self._ok_json({'live': [], 'vod': [], 'series': []})
        # Try fast-search via Xtream search param; fall back to category scan
        result = {'live': [], 'vod': [], 'series': []}
        try:
            def normalize_and_limit(items, name_keys, limit=60):
                out = []
                for it in items or []:
                    text = ''
                    for k in name_keys:
                        if it.get(k):
                            text = str(it.get(k))
                            break
                    if not text:
                        continue
                    if query in text.lower():
                        out.append(it)
                    if len(out) >= limit:
                        break
                return out

            def try_fast_search(tkey, action_streams, name_keys):
                if type_filter not in ('all', tkey):
                    return []
                try:
                    items = self.call_xtream(creds, action_streams, {'search': query})
                    if isinstance(items, list) and items:
                        return normalize_and_limit(items, name_keys)
                except Exception:
                    pass
                return []

            def slow_scan(tkey, action_cat, action_streams, name_keys, max_categories=None):
                if type_filter not in ('all', tkey):
                    return []
                categories = self.call_xtream(creds, action_cat) or []
                matches = []
                for idx, c in enumerate(categories):
                    if max_categories is not None and idx >= max_categories:
                        break
                    cat_id = c.get('category_id')
                    if not cat_id:
                        continue
                    items = self.call_xtream(creds, action_streams, {'category_id': cat_id}) or []
                    filtered = normalize_and_limit(items, name_keys, limit=60 - len(matches))
                    matches.extend(filtered)
                    if len(matches) >= 60:
                        break
                return matches

            # live
            live_matches = try_fast_search('live', 'get_live_streams', ['name', 'title'])
            if not live_matches:
                live_matches = slow_scan('live', 'get_live_categories', 'get_live_streams', ['name', 'title'])
            result['live'] = live_matches

            # vod (movies)
            vod_matches = try_fast_search('vod', 'get_vod_streams', ['name', 'title'])
            if not vod_matches:
                vod_matches = slow_scan('vod', 'get_vod_categories', 'get_vod_streams', ['name', 'title'])
            result['vod'] = vod_matches

            # series
            series_matches = try_fast_search('series', 'get_series', ['series_name', 'name', 'title'])
            if not series_matches:
                series_matches = slow_scan('series', 'get_series_categories', 'get_series', ['series_name', 'name', 'title'])
            result['series'] = series_matches

        except Exception as e:
            return self._err(500, f'Search failed: {e}')
        return self._ok_json(result)

    def handle_compat_vod(self, sid):
        """FFmpeg proxy: remux VOD to MP4/AAC for browser audio compatibility."""
        user = self.authenticate()
        if not user:
            return
        creds = self.get_xtream_credentials(user['id'])
        if not creds:
            return self._err(400, 'IPTV credentials not set for this user')
        if not shutil.which('ffmpeg'):
            return self._err(500, 'FFmpeg not found on server PATH')

        q = parse_qs(urlparse(self.path).query)
        ext = q.get('ext', ['mp4'])[0]
        remote = f"{creds['server_url']}/movie/{creds['iptv_username']}/{creds['iptv_password']}/{sid}.{ext}"

        # Use segmenting to enable accurate duration and instant seeking across long movies
        cmd = [
            'ffmpeg','-hide_banner','-loglevel','error',
            '-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','4',
            '-i', remote,
            '-c:v','copy','-c:a','aac','-ac','2','-b:a','160k',
            '-f','mp4','-movflags','+faststart+frag_keyframe+empty_moov+separate_moof+delay_moov',
            'pipe:1'
        ]
        try:
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
            self.send_response(200)
            self.send_header('Content-Type', 'video/mp4')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            for chunk in iter(lambda: p.stdout.read(64 * 1024), b''):
                self.wfile.write(chunk)
            p.stdout.close()
            p.wait(timeout=5)
        except BrokenPipeError:
            try:
                p.kill()
            except Exception:
                pass
        except Exception as e:
            try:
                p.kill()
            except Exception:
                pass
            return self._err(500, f'FFmpeg error: {e}')

    def handle_compat_live(self, sid):
        """FFmpeg proxy for LIVE: remux MPEG-TS to fMP4/AAC for browser playback."""
        user = self.authenticate()
        if not user:
            return
        creds = self.get_xtream_credentials(user['id'])
        if not creds:
            return self._err(400, 'IPTV credentials not set for this user')
        if not shutil.which('ffmpeg'):
            return self._err(500, 'FFmpeg not found on server PATH')

        remote = f"{creds['server_url']}/live/{creds['iptv_username']}/{creds['iptv_password']}/{sid}.ts"
        cmd = [
            'ffmpeg','-hide_banner','-loglevel','error',
            '-fflags','+nobuffer','-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','4',
            '-i', remote,
            '-c:v','copy','-c:a','aac','-ac','2','-b:a','128k',
            '-f','mp4','-movflags','+faststart+frag_keyframe+empty_moov+separate_moof+delay_moov',
            'pipe:1'
        ]
        try:
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
            self.send_response(200)
            self.send_header('Content-Type', 'video/mp4')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            for chunk in iter(lambda: p.stdout.read(64 * 1024), b''):
                self.wfile.write(chunk)
        except BrokenPipeError:
            try:
                p.kill()
            except Exception:
                pass
        except Exception as e:
            try:
                p.kill()
            except Exception:
                pass
            return self._err(500, f'FFmpeg error: {e}')

    def handle_compat_series(self, sid):
        """FFmpeg proxy for SERIES episodes: remux to fMP4/AAC for consistent audio and seeking."""
        user = self.authenticate()
        if not user:
            return
        creds = self.get_xtream_credentials(user['id'])
        if not creds:
            return self._err(400, 'IPTV credentials not set for this user')
        if not shutil.which('ffmpeg'):
            return self._err(500, 'FFmpeg not found on server PATH')

        q = parse_qs(urlparse(self.path).query)
        ext = q.get('ext', ['mp4'])[0]
        remote = f"{creds['server_url']}/series/{creds['iptv_username']}/{creds['iptv_password']}/{sid}.{ext}"

        cmd = [
            'ffmpeg','-hide_banner','-loglevel','error',
            '-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','4',
            '-i', remote,
            '-c:v','copy','-c:a','aac','-ac','2','-b:a','160k',
            '-f','mp4','-movflags','+faststart+frag_keyframe+empty_moov+separate_moof+delay_moov',
            'pipe:1'
        ]
        try:
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
            self.send_response(200)
            self.send_header('Content-Type', 'video/mp4')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            for chunk in iter(lambda: p.stdout.read(64 * 1024), b''):
                self.wfile.write(chunk)
            p.stdout.close()
            p.wait(timeout=5)
        except BrokenPipeError:
            try:
                p.kill()
            except Exception:
                pass
        except Exception as e:
            try:
                p.kill()
            except Exception:
                pass
            return self._err(500, f'FFmpeg error: {e}')

    # --- Media caching removed entirely ---

def run_server(port=5000):
    init_db()
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
    except Exception:
        pass
    addr = ('', port)
    httpd = ThreadingHTTPServer(addr, IPTVRequestHandler)
    print(f"Serving on port {port}...")
    httpd.serve_forever()

if __name__ == '__main__':
    run_server()
