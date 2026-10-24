#!/usr/bin/env python3
"""Run as root on N100S. Inventory configuration; never change app/service/storage settings."""
import concurrent.futures
import datetime
import gzip
import hashlib
import importlib.util
import itertools
import json
import os
from pathlib import Path
import posixpath
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse

import types
PROBE_SOURCE = '#!/usr/bin/env python3\n"""Bounded read-only probe; stdout is a credential-redacted JSON inventory."""\nimport argparse\nimport configparser\nimport errno\nimport json\nimport os\nfrom pathlib import Path\nimport re\nimport shutil\nimport sqlite3\nimport subprocess\nimport urllib.error\nimport urllib.parse\nimport urllib.request\nimport xml.etree.ElementTree as ET\n\nSECRETS = set()\nPATHS = set()\nWARNINGS = []\nMAX_FILE = 2 * 1024 * 1024\nSECRET_KEY = re.compile(r\'password|passwd|api.?key|token|secret|cookie|credential\', re.I)\n\n\ndef remember(key, value):\n    if SECRET_KEY.search(str(key)) and isinstance(value, str) and len(value) >= 6:\n        SECRETS.add(value)\n\n\ndef scrub(value):\n    if isinstance(value, dict):\n        return {str(k): scrub(v) for k, v in value.items()}\n    if isinstance(value, list):\n        return [scrub(v) for v in value]\n    if isinstance(value, str):\n        for secret in sorted(SECRETS, key=len, reverse=True):\n            value = value.replace(secret, \'[redacted]\')\n        return value\n    return value\n\n\ndef origin(raw):\n    if not raw or not isinstance(raw, str):\n        return None\n    try:\n        url = urllib.parse.urlsplit(raw if \'://\' in raw else \'http://\' + raw)\n        if not url.hostname:\n            return None\n        host = \'[\' + url.hostname + \']\' if \':\' in url.hostname else url.hostname\n        return url.scheme + \'://\' + host + (\':\' + str(url.port) if url.port else \'\')\n    except ValueError:\n        return None\n\n\ndef path_value(value):\n    if isinstance(value, str) and value.strip():\n        value = value.strip()\n        if value.startswith(\'/\'):\n            PATHS.add(value)\n        return value\n    return None\n\n\ndef run(args, timeout=5, cap=MAX_FILE):\n    # Output stays local until selected fields have been extracted.\n    try:\n        with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as proc:\n            try:\n                out = proc.communicate(timeout=timeout)[0]\n            except subprocess.TimeoutExpired:\n                proc.kill()\n                proc.communicate()\n                return None\n            return out.decode(errors=\'replace\') if proc.returncode == 0 and len(out) <= cap else None\n    except OSError:\n        return None\n\n\ndef read_text(path):\n    try:\n        target = Path(path)\n        if target.stat().st_size > MAX_FILE:\n            return None\n        return target.read_text(errors=\'replace\')\n    except OSError:\n        return None\n\n\ndef json_value(value, default=None):\n    try:\n        return json.loads(value) if value is not None else default\n    except (ValueError, TypeError):\n        return default\n\n\ndef service(name):\n    text = run([\'systemctl\', \'show\', name, \'--property=LoadState,ActiveState,SubState,MainPID,User,Group,Result,FragmentPath,WorkingDirectory\'])\n    if text is None:\n        return {\'query_failed\': True}, None, []\n    values = dict(line.split(\'=\', 1) for line in text.splitlines() if \'=\' in line)\n    pid = values.get(\'MainPID\', \'0\')\n    args = []\n    if pid.isdigit() and int(pid) > 0:\n        try:\n            args = Path(\'/proc\', pid, \'cmdline\').read_bytes().decode(errors=\'replace\').split(\'\\0\')\n            status = Path(\'/proc\', pid, \'status\').read_text()\n            values[\'effective_identity\'] = {line.split(\':\', 1)[0].lower(): int(line.split()[2])\n                for line in status.splitlines() if line.startswith((\'Uid:\', \'Gid:\'))}\n        except (OSError, IndexError, ValueError):\n            pass\n    return values, pid if pid.isdigit() and int(pid) > 0 else None, args\n\n\ndef environment(pid, keys):\n    result = {}\n    if pid:\n        try:\n            for item in Path(\'/proc\', pid, \'environ\').read_bytes().split(b\'\\0\'):\n                key, sep, value = item.partition(b\'=\')\n                name = key.decode(errors=\'replace\')\n                if sep and name in keys:\n                    result[name] = value.decode(errors=\'replace\')\n                    remember(name, result[name])\n        except OSError:\n            pass\n    return result\n\n\ndef env_file(path, keys):\n    result = {}\n    for line in (read_text(path) or \'\').splitlines():\n        key, sep, value = line.strip().removeprefix(\'export \').partition(\'=\')\n        key = key.strip()\n        if sep and key in keys:\n            value = value.strip()\n            if len(value) >= 2 and value[0] == value[-1] and value[0] in {\'"\', "\'"}:\n                value = value[1:-1]\n            result[key] = value\n            remember(key, value)\n    return result\n\n\ndef config_candidates(args, defaults, flags=(\'-c\', \'-f\', \'--config\', \'--config-file\')):\n    candidates = []\n    for i, arg in enumerate(args):\n        if arg in flags and i + 1 < len(args):\n            candidates.append(args[i + 1])\n        elif any(arg.startswith(flag + \'=\') for flag in flags):\n            candidates.append(arg.split(\'=\', 1)[1])\n    return list(dict.fromkeys(candidates + defaults))\n\n\ndef mount_options(raw):\n    allowed = {\'ro\', \'rw\', \'relatime\', \'noatime\', \'nosuid\', \'nodev\', \'noexec\', \'vers\', \'nfsvers\',\n               \'sec\', \'uid\', \'gid\', \'anonuid\', \'anongid\', \'file_mode\', \'dir_mode\', \'proto\', \'hard\', \'soft\'}\n    return \',\'.join(option for option in str(raw or \'\').split(\',\') if option.split(\'=\', 1)[0] in allowed)\n\n\ndef safe_mount_source(raw):\n    value = str(raw or \'\')\n    value = re.sub(r\'(?<=//)[^/@\\s]+@\', \'[redacted]@\', value)\n    return value.split(\'?\', 1)[0]\n\n\ndef flatten_mounts(records):\n    output = []\n    for entry in records or []:\n        target = entry.get(\'target\', \'\')\n        fs = entry.get(\'fstype\', \'\')\n        if target == \'/\' or fs in {\'nfs\', \'nfs4\', \'cifs\', \'ext4\', \'xfs\', \'btrfs\', \'zfs\', \'overlay\', \'9p\', \'virtiofs\'} or target.startswith((\'/music\', \'/downloads\', \'/data\', \'/mnt/\', \'/media/\')):\n            output.append({\'target\': target, \'source\': safe_mount_source(entry.get(\'source\')),\n                           \'fstype\': fs, \'options\': mount_options(entry.get(\'options\'))})\n        output.extend(flatten_mounts(entry.get(\'children\', [])))\n    return output[:256]\n\n\ndef path_stat(path):\n    result = {\'path\': path}\n    try:\n        info = os.stat(path)\n        result.update(exists=True, is_directory=Path(path).is_dir(), realpath=os.path.realpath(path),\n                      device=info.st_dev, inode=info.st_ino, uid=info.st_uid, gid=info.st_gid,\n                      mode=oct(info.st_mode & 0o7777), probe_can_read=os.access(path, os.R_OK),\n                      probe_can_write=os.access(path, os.W_OK))\n        fs = os.statvfs(path)\n        result[\'available_bytes\'] = fs.f_bavail * fs.f_frsize\n    except OSError as error:\n        result.update(exists=False if error.errno in {errno.ENOENT, errno.ENOTDIR} else None,\n                      stat_error_errno=error.errno)\n    return result\n\n\nclass NoRedirect(urllib.request.HTTPRedirectHandler):\n    def redirect_request(self, *args, **kwargs):\n        return None\n\n\ndef api_get(base, key, endpoint):\n    if not key or key.startswith(\'AURRAL_ENC:\'):\n        return None, \'credential unavailable to this read-only probe\'\n    remember(\'apiKey\', key)\n    try:\n        parsed = urllib.parse.urlsplit(base)\n        if parsed.scheme not in {\'http\', \'https\'} or not parsed.hostname:\n            return None, \'invalid endpoint\'\n        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)\n        request = urllib.request.Request(base.rstrip(\'/\') + endpoint,\n            headers={\'X-Api-Key\': key, \'Accept\': \'application/json\'})\n        with opener.open(request, timeout=4) as response:\n            data = response.read(MAX_FILE + 1)\n            if len(data) > MAX_FILE:\n                return None, \'response exceeds 2 MiB cap\'\n            return json.loads(data), None\n    except urllib.error.HTTPError as error:\n        return None, \'HTTP \' + str(error.code)\n    except (OSError, ValueError):\n        return None, \'request failed (network, TLS, or JSON)\'\n\n\ndef arr_config(args, name):\n    paths = []\n    for i, arg in enumerate(args):\n        if arg.lower().startswith((\'-data=\', \'--data=\')):\n            paths.append(str(Path(arg.split(\'=\', 1)[1]) / \'config.xml\'))\n        elif arg.lower() in {\'-data\', \'--data\'} and i + 1 < len(args):\n            paths.append(str(Path(args[i + 1]) / \'config.xml\'))\n    paths += [f\'/var/lib/{name}/config.xml\', f\'/root/.config/{name.capitalize()}/config.xml\', \'/config/config.xml\']\n    for path in dict.fromkeys(paths):\n        text = read_text(path)\n        if text is None:\n            continue\n        try:\n            root = ET.fromstring(text)\n            key = root.findtext(\'ApiKey\') or \'\'\n            remember(\'ApiKey\', key)\n            ssl = (root.findtext(\'EnableSsl\') or \'\').lower() == \'true\'\n            port = root.findtext(\'SslPort\' if ssl else \'Port\') or (\'6868\' if ssl else \'8686\' if name == \'lidarr\' else \'9696\')\n            base = \'/\' + (root.findtext(\'UrlBase\') or \'\').strip(\'/\')\n            return {\'file\': path, \'key_present\': bool(key), \'bind_address\': root.findtext(\'BindAddress\'),\n                    \'port\': port, \'ssl\': ssl, \'url_base\': base}, f"{\'https\' if ssl else \'http\'}://127.0.0.1:{port}{base.rstrip(\'/\')}", key\n        except ET.ParseError:\n            continue\n    return {\'config_not_found\': True}, None, None\n\n\ndef field_summary(item):\n    output = {key: item.get(key) for key in [\'name\', \'implementation\', \'enable\', \'protocol\', \'priority\']}\n    fields = {}\n    for field in item.get(\'fields\') or []:\n        if not isinstance(field, dict):\n            continue\n        name, value = str(field.get(\'name\', \'\')), field.get(\'value\')\n        remember(name, value)\n        if SECRET_KEY.search(name):\n            fields[name + \'_present\'] = bool(value)\n        elif name.lower() in {\'host\', \'server\', \'url\', \'baseurl\', \'prowlarrurl\', \'lidarrurl\', \'sabnzbdurl\', \'port\', \'usessl\', \'category\', \'musiccategory\', \'tvcategory\', \'categories\', \'synclevel\', \'addpaused\', \'removemetadata\'}:\n            if \'url\' in name.lower() or name.lower() in {\'host\', \'server\'}:\n                fields[name] = origin(value) if isinstance(value, str) else None\n            else:\n                fields[name] = value\n        elif name.lower() in {\'directory\', \'downloadpath\', \'downloadclientpath\', \'mappedpath\', \'downloadfolder\', \'completeddownloadfolder\', \'localpath\', \'remotepath\'}:\n            fields[name] = path_value(value)\n    output[\'fields\'] = fields\n    return output\n\n\ndef arr_inventory(name, args):\n    config, base, key = arr_config(args, name)\n    output = {\'config\': config}\n    if not base or not key:\n        return output\n    status, error = api_get(base, key, \'/api/v1/system/status\')\n    if error or not isinstance(status, dict) or not status.get(\'version\'):\n        output[\'api_status\'] = error or \'unexpected status response\'\n        return output\n    output[\'version\'] = status.get(\'version\')\n    output[\'api_status\'] = \'reachable\'\n    endpoints = [\'downloadclient\', \'indexer\', \'health\']\n    endpoints += [\'rootfolder\', \'remotepathmapping\', \'qualityprofile\', \'metadataprofile\'] if name == \'lidarr\' else [\'applications\']\n    for endpoint in endpoints:\n        data, error = api_get(base, key, \'/api/v1/\' + endpoint)\n        if error or not isinstance(data, list):\n            output[endpoint] = {\'unavailable\': error or \'unexpected response\'}\n            continue\n        if len(data) > 200:\n            WARNINGS.append(name + \' \' + endpoint + \' capped at 200 entries\')\n        safe = []\n        for item in data[:200]:\n            if not isinstance(item, dict):\n                continue\n            if endpoint in {\'downloadclient\', \'applications\'}:\n                safe.append(field_summary(item))\n            elif endpoint == \'indexer\':\n                result = {k: item.get(k) for k in [\'name\', \'implementation\', \'protocol\', \'enable\', \'enableRss\', \'enableAutomaticSearch\', \'enableInteractiveSearch\', \'privacy\', \'priority\', \'syncProfileId\', \'tags\']}\n                for field in item.get(\'fields\') or []:\n                    if isinstance(field, dict):\n                        remember(field.get(\'name\'), field.get(\'value\'))\n                safe.append(result)\n            elif endpoint == \'rootfolder\':\n                safe.append({\'path\': path_value(item.get(\'path\')), \'accessible\': item.get(\'accessible\'), \'free_space_bytes\': item.get(\'freeSpace\')})\n            elif endpoint == \'remotepathmapping\':\n                safe.append({\'host\': origin(item.get(\'host\')), \'remotePath\': item.get(\'remotePath\'), \'localPath\': path_value(item.get(\'localPath\'))})\n            elif endpoint == \'health\':\n                safe.append({k: item.get(k) for k in [\'source\', \'type\']})\n            else:\n                safe.append({k: item.get(k) for k in [\'id\', \'name\', \'upgradeAllowed\']})\n        output[endpoint] = safe\n    if name == \'lidarr\':\n        for endpoint in [\'config/downloadclient\', \'config/mediamanagement\']:\n            data, error = api_get(base, key, \'/api/v1/\' + endpoint)\n            output[endpoint] = ({k: data.get(k) for k in [\'enableCompletedDownloadHandling\', \'autoRedownloadFailed\', \'autoRedownloadFailedFromInteractiveSearch\', \'copyUsingHardlinks\', \'setPermissionsLinux\', \'chmodFolder\', \'chownGroup\']}\n                if isinstance(data, dict) else {\'unavailable\': error or \'unexpected response\'})\n    return output\n\n\ndef readonly_db(path):\n    con = sqlite3.connect(Path(path).resolve().as_uri() + \'?mode=ro\', uri=True, timeout=2)\n    con.row_factory = sqlite3.Row\n    con.execute(\'PRAGMA query_only=ON\')\n    return con\n\n\ndef normalize_mode(raw):\n    mode = str(raw or \'\').strip().lower()\n    return \'download\' if mode == \'download\' else \'reuse\'\n\n\ndef aurral_inventory(pid):\n    keys = {\'PLAYLIST_FOLDER\', \'WEEKLY_FLOW_FOLDER\', \'DOWNLOAD_FOLDER\', \'PATH_MAPPINGS\', \'AURRAL_DATA_DIR\',\n            \'LIDARR_URL\', \'LIDARR_API_KEY\', \'SLSKD_URL\', \'SLSKD_API_KEY\', \'SABNZBD_URL\', \'SABNZBD_API_KEY\', \'PROWLARR_URL\', \'PROWLARR_API_KEY\',\n            \'NZBGET_URL\', \'NZBGET_USER\', \'NZBGET_PASS\', \'LASTFM_API_KEY\'}\n    env = env_file(\'/opt/aurral/backend/.env\', keys) | environment(pid, keys)\n    output = {\'env_file_checked\': \'/opt/aurral/backend/.env\'}\n    databases = [\'/opt/aurral_data/aurral.db\']\n    if env.get(\'AURRAL_DATA_DIR\'):\n        databases.insert(0, str(Path(env[\'AURRAL_DATA_DIR\']) / \'aurral.db\'))\n    rows = None\n    for database in dict.fromkeys(databases):\n        if not Path(database).is_file():\n            continue\n        try:\n            with readonly_db(database) as con:\n                rows = {row[\'key\']: row[\'value\'] for row in con.execute(\n                    "SELECT key,value FROM settings WHERE key IN (\'downloadFolderPath\',\'rootFolderPath\',\'playlistWorker\',\'weeklyFlowWorker\',\'pathMappings\',\'integrations\')")}\n            output[\'database\'] = database\n            break\n        except sqlite3.Error:\n            WARNINGS.append(\'Could not read Aurral settings database\')\n    if rows is None:\n        output[\'settings_unavailable\'] = True\n        return output\n    stored = rows.get(\'downloadFolderPath\')\n    selected_env = next((name for name in [\'PLAYLIST_FOLDER\', \'WEEKLY_FLOW_FOLDER\', \'DOWNLOAD_FOLDER\'] if env.get(name)), None)\n    default = \'/data/downloads/aurral\' if os.path.isdir(\'/data\') and os.access(\'/data\', os.W_OK) else \'/opt/aurral_data/downloads/aurral\'\n    folder = stored or (env[selected_env] if selected_env else default)\n    output[\'download_folder\'] = {\'path\': path_value(folder), \'source\': \'settings\' if stored else selected_env or \'inferred_default\',\n                                 \'runtime_path_verified\': bool(stored)}\n    output[\'stored_root_folder\'] = path_value(rows.get(\'rootFolderPath\'))\n    worker = json_value(rows.get(\'playlistWorker\') or rows.get(\'weeklyFlowWorker\'), {}) or {}\n    output[\'worker\'] = {\'concurrency\': worker.get(\'concurrency\', 2), \'existing_file_mode\': normalize_mode(worker.get(\'existingFileMode\'))}\n    mappings = json_value(rows.get(\'pathMappings\'), []) or []\n    output[\'path_mappings\'] = [{\'source\': m.get(\'source\', \'all\'), \'remote\': m.get(\'remote\'), \'local\': path_value(m.get(\'local\'))}\n                              for m in mappings[:100] if isinstance(m, dict)]\n    output[\'environment_path_mappings\'] = []\n    for segment in env.get(\'PATH_MAPPINGS\', \'\').split(\';\'):\n        pieces = segment.split(\'|\')\n        if len(pieces) in {2, 3}:\n            output[\'environment_path_mappings\'].append({\'source\': pieces[0] if len(pieces) == 3 else \'all\',\n                \'remote\': pieces[-2], \'local\': path_value(pieces[-1])})\n    integrations = json_value(rows.get(\'integrations\'), {}) or {}\n    output[\'integrations\'] = {}\n    for name in [\'lidarr\', \'slskd\', \'sabnzbd\', \'nzbget\', \'prowlarr\', \'ytdlp\', \'navidrome\']:\n        data = integrations.get(name) or {}\n        if not isinstance(data, dict):\n            continue\n        for k, v in data.items():\n            remember(k, v)\n        prefix = name.upper()\n        credential = data.get(\'apiKey\') or data.get(\'password\') or env.get(prefix + \'_API_KEY\') or env.get(prefix + \'_PASS\')\n        entry = {\'enabled\': data.get(\'enabled\'), \'endpoint\': origin(data.get(\'url\') or env.get(prefix + \'_URL\')),\n                 \'credential_present\': bool(credential), \'credential_encrypted\': isinstance(credential, str) and credential.startswith(\'AURRAL_ENC:\'),\n                 \'credential_validity_tested\': False, \'priority\': data.get(\'priority\')}\n        for field in [\'rootFolderPath\', \'stagingPath\', \'downloadPath\', \'downloadFolder\', \'outputPath\']:\n            if data.get(field):\n                entry[field] = path_value(data[field])\n        if isinstance(data.get(\'rootFolderPaths\'), list):\n            entry[\'rootFolderPaths\'] = [path_value(p) for p in data[\'rootFolderPaths\'][:100] if isinstance(p, str)]\n        output[\'integrations\'][name] = entry\n    # Probe known aliases and transfer roots without walking any media files.\n    for path in [\'/music\', \'/music/Aurral\', \'/music/Downloads\', \'/downloads/aurral\', \'/downloads/slskd\', \'/downloads/sabnzbd\', \'/opt/aurral_data/_staging\']:\n        PATHS.add(path)\n    output[\'lastfm_key_present\'] = bool((integrations.get(\'lastfm\') or {}).get(\'apiKey\') or env.get(\'LASTFM_API_KEY\'))\n    return output\n\n\ndef configobj_sections(text):\n    """Subset needed for SAB\'s scalar folder/server/category settings; never executes config."""\n    output = {}\n    levels = []\n    for line in text.splitlines():\n        line = line.strip()\n        if not line or line.startswith((\'#\', \';\')):\n            continue\n        match = re.fullmatch(r\'(\\[+)([^\\[\\]]+)(\\]+)\', line)\n        if match and len(match[1]) == len(match[3]):\n            depth = len(match[1])\n            levels = levels[:depth - 1] + [match[2].strip()]\n            continue\n        key, sep, value = line.partition(\'=\')\n        if not sep:\n            continue\n        value = value.strip()\n        if len(value) >= 2 and value[0] == value[-1] and value[0] in {\'"\', "\'"}:\n            value = value[1:-1]\n        remember(key, value)\n        output.setdefault(tuple(levels), {})[key.strip()] = value\n    return output\n\n\ndef sab_inventory(args):\n    candidates = config_candidates(args, [\'/root/.sabnzbd/sabnzbd.ini\', \'/var/lib/sabnzbd/sabnzbd.ini\', \'/opt/sabnzbd/sabnzbd.ini\', \'/etc/sabnzbd/sabnzbd.ini\'])\n    for candidate in candidates:\n        text = read_text(candidate)\n        if text is None:\n            continue\n        sections = configobj_sections(text)\n        misc = sections.get((\'misc\',), {})\n        if not misc:\n            continue\n        output = {\'config_file\': candidate, \'folders\': {}, \'servers\': [], \'categories\': []}\n        for key in [\'download_dir\', \'complete_dir\', \'dirscan_dir\', \'nzb_backup_dir\', \'script_dir\', \'admin_dir\']:\n            output[\'folders\'][key] = path_value(misc.get(key))\n        output[\'web\'] = {\'host\': misc.get(\'host\'), \'port\': misc.get(\'port\'), \'https_port\': misc.get(\'https_port\'),\n                         \'enable_https\': misc.get(\'enable_https\'), \'api_key_present\': bool(misc.get(\'api_key\'))}\n        for section, values in sections.items():\n            if len(section) == 2 and section[0] == \'servers\':\n                output[\'servers\'].append({k: values.get(k) for k in [\'name\', \'host\', \'port\', \'ssl\', \'connections\', \'enable\', \'required\', \'optional\', \'priority\', \'retention\']})\n            elif len(section) == 2 and section[0] == \'categories\':\n                rawdir = values.get(\'dir\', \'\')\n                complete = misc.get(\'complete_dir\', \'\')\n                effective = rawdir if rawdir.startswith(\'/\') else os.path.join(complete, rawdir) if complete else None\n                output[\'categories\'].append({\'name\': section[1], \'folder_setting\': rawdir,\n                                              \'resolved_folder_if_absolute_base\': path_value(effective), \'priority\': values.get(\'priority\')})\n        return output\n    return {\'config_not_found\': True}\n\n\ndef qb_inventory(args):\n    candidates = [\'/root/.config/qBittorrent/qBittorrent.conf\', \'/home/qbittorrent/.config/qBittorrent/qBittorrent.conf\',\n                  \'/var/lib/qbittorrent/.config/qBittorrent/qBittorrent.conf\', \'/config/qBittorrent/qBittorrent.conf\', \'/opt/qbittorrent/config/qBittorrent.conf\']\n    for arg in args:\n        if arg.startswith(\'--profile=\'):\n            candidates.insert(0, str(Path(arg.split(\'=\', 1)[1]) / \'qBittorrent\' / \'config\' / \'qBittorrent.conf\'))\n    output = {\'configs\': []}\n    for candidate in dict.fromkeys(candidates):\n        text = read_text(candidate)\n        if text is None:\n            continue\n        parser = configparser.RawConfigParser(strict=False, interpolation=None)\n        parser.optionxform = str\n        try:\n            parser.read_string(text)\n        except configparser.Error:\n            continue\n        fields = {}\n        for section in parser.sections():\n            for key, value in parser.items(section):\n                remember(key, value)\n                if key in {\'Downloads\\\\SavePath\', \'Downloads\\\\TempPath\', \'Downloads\\\\TempPathEnabled\', \'Session\\\\DefaultSavePath\', \'Session\\\\TempPath\', \'Session\\\\TempPathEnabled\', \'WebUI\\\\Address\', \'WebUI\\\\Port\', \'WebUI\\\\HTTPS\\\\Enabled\', \'Connection\\\\Interface\', \'Session\\\\Interface\', \'Session\\\\InterfaceName\'}:\n                    fields[section + \'/\' + key] = path_value(value) if \'Path\' in key and \'Enabled\' not in key else value\n        categories_file = str(Path(candidate).with_name(\'categories.json\'))\n        categories = json_value(read_text(categories_file), {})\n        safe_categories = []\n        if isinstance(categories, dict):\n            for name, category in list(categories.items())[:100]:\n                if isinstance(category, dict):\n                    safe_categories.append({\'name\': name, \'save_path\': path_value(category.get(\'save_path\') or category.get(\'savePath\'))})\n        output[\'configs\'].append({\'file\': candidate, \'fields\': fields, \'categories\': safe_categories})\n    if not output[\'configs\']:\n        output[\'config_not_found\'] = True\n    return output\n\n\ndef rdt_inventory(args):\n    candidates = [\'/opt/rdtclient/db/rdtclient.db\', \'/opt/rdtclient/rdtclient.db\', \'/data/db/rdtclient.db\',\n                  \'/data/rdtclient.db\', \'/config/rdtclient.db\', \'/opt/rdt-client/db/rdtclient.db\']\n    for arg in args:\n        if arg.endswith(\'.dll\') and arg.startswith(\'/\'):\n            candidates.insert(0, str(Path(arg).parent / \'db\' / \'rdtclient.db\'))\n    for candidate in dict.fromkeys(candidates):\n        if not Path(candidate).is_file():\n            continue\n        try:\n            with readonly_db(candidate) as con:\n                columns = {row[\'name\'] for row in con.execute(\'PRAGMA table_info(Settings)\')}\n                if not {\'SettingId\', \'Value\'} <= columns:\n                    continue\n                rows = con.execute(\'SELECT SettingId,Value FROM Settings LIMIT 500\').fetchall()\n            fields = {}\n            for row in rows:\n                key, value = row[\'SettingId\'], row[\'Value\']\n                remember(key, value)\n                if key in {\'DownloadClient:DownloadPath\', \'DownloadClient:MappedPath\', \'DownloadClient:Client\', \'DownloadClient:DownloadClientType\',\n                           \'DownloadClient:AddCategoryToPath\', \'DownloadClient:DeleteOnImport\', \'Provider:Provider\', \'Provider\', \'DownloadPath\', \'MappedPath\'}:\n                    fields[key] = path_value(value) if key.endswith(\'Path\') else value\n            return {\'database\': candidate, \'fields\': fields, \'queue_and_provider_credentials_not_exported\': True}\n        except sqlite3.Error:\n            continue\n    return {\'config_not_found\': True}\n\n\ndef slskd_inventory(pid, args):\n    env = environment(pid, {\'SLSKD_APP_DIR\', \'SLSKD_CONFIG\', \'SLSKD_DOWNLOADS_DIR\', \'SLSKD_INCOMPLETE_DIR\'})\n    candidates = config_candidates(args, [\'/var/lib/slskd/slskd.yml\', \'/etc/slskd/slskd.yml\', \'/opt/slskd/slskd.yml\',\n                                          \'/root/.local/share/slskd/slskd.yml\', \'/opt/slskd/config/slskd.yml\', \'/opt/slskd/data/slskd.yml\'], (\'--config\',))\n    if env.get(\'SLSKD_CONFIG\'):\n        candidates.insert(0, env[\'SLSKD_CONFIG\'])\n    if env.get(\'SLSKD_APP_DIR\'):\n        candidates.insert(0, str(Path(env[\'SLSKD_APP_DIR\']) / \'slskd.yml\'))\n    output = {\'directories\': {key: path_value(value) for key, value in env.items() if key.endswith(\'_DIR\')}}\n    for candidate in dict.fromkeys(candidates):\n        text = read_text(candidate)\n        if text is None:\n            continue\n        output[\'config_file\'] = candidate\n        section = None\n        for line in text.splitlines():\n            stripped = line.strip()\n            if not stripped or stripped.startswith(\'#\'):\n                continue\n            if not line[0].isspace():\n                section = stripped.split(\':\', 1)[0]\n            key, sep, value = stripped.partition(\':\')\n            remember(key, value.strip())\n            if section == \'directories\' and key in {\'downloads\', \'incomplete\'} and sep:\n                output[\'directories\'][key] = path_value(value.strip().strip(\'"\\\'\'))\n        break\n    if \'config_file\' not in output:\n        output[\'config_not_found\'] = True\n    return output\n\n\ndef nzbget_inventory(args):\n    candidates = config_candidates(args, [\'/usr/local/etc/nzbget.conf\', \'/etc/nzbget.conf\', \'/opt/nzbget/nzbget.conf\', \'/usr/local/nzbget/nzbget.conf\', \'/root/.nzbget\'])\n    for candidate in candidates:\n        text = read_text(candidate)\n        if text is None:\n            continue\n        paths, server_values, categories = {}, {}, {}\n        for line in text.splitlines():\n            key, sep, value = line.strip().partition(\'=\')\n            if not sep or key.startswith(\'#\'):\n                continue\n            remember(key, value)\n            if key in {\'MainDir\', \'DestDir\', \'InterDir\', \'TempDir\', \'NzbDir\', \'QueueDir\', \'ScriptDir\'}:\n                paths[key] = value\n            server = re.fullmatch(r\'Server(\\d+)\\.(Host|Port|Encryption|Active|Connections|Level|Name)\', key)\n            category = re.fullmatch(r\'Category(\\d+)\\.(Name|DestDir|Unpack)\', key)\n            if server:\n                server_values.setdefault(server[1], {})[server[2]] = value\n            elif category:\n                categories.setdefault(category[1], {})[category[2]] = value\n        main = paths.get(\'MainDir\', \'\')\n        paths = {key: path_value(value.replace(\'${MainDir}\', main)) for key, value in paths.items()}\n        for category in categories.values():\n            if category.get(\'DestDir\'):\n                category[\'DestDir\'] = path_value(category[\'DestDir\'].replace(\'${MainDir}\', main))\n        return {\'config_file\': candidate, \'paths\': paths, \'servers\': list(server_values.values()), \'categories\': list(categories.values())}\n    return {\'config_not_found\': True}\n\n\ndef docker_inventory():\n    if not shutil.which(\'docker\'):\n        return []\n    text = run([\'docker\', \'ps\', \'-a\', \'--format\', \'{{.ID}}|{{.Names}}|{{.Status}}\'], timeout=4)\n    if text is None:\n        return [{\'unavailable\': True}]\n    output = []\n    for line in text.splitlines()[:8]:\n        parts = line.split(\'|\', 2)\n        if len(parts) != 3:\n            continue\n        cid, name, status = parts\n        mounts = json_value(run([\'docker\', \'inspect\', \'--format\', \'{{json .Mounts}}\', cid], timeout=3), [])\n        output.append({\'name\': name, \'status\': status, \'mounts\': [\n            {\'source\': path_value(m.get(\'Source\')), \'destination\': m.get(\'Destination\'), \'rw\': m.get(\'RW\'), \'type\': m.get(\'Type\')}\n            for m in mounts if isinstance(m, dict)]})\n    return output\n\n\ndef inspect(role):\n    expected = {\'aurral\': [\'aurral.service\'], \'lidarr\': [\'lidarr.service\', \'Lidarr.service\'], \'prowlarr\': [\'prowlarr.service\', \'Prowlarr.service\'],\n                \'sabnzbd\': [\'sabnzbd.service\', \'sabnzbdplus.service\'], \'nzbget\': [\'nzbget.service\'],\n                \'rdtclient\': [\'rdtclient.service\', \'rdt-client.service\'], \'qbittorrent\': [\'qbittorrent.service\', \'qbittorrent-nox.service\'],\n                \'slskd\': [\'slskd.service\']}\n    services = {}; selected_pid = None; selected_args = []\n    units = list(expected.get(role, []))\n    listed = run([\'systemctl\', \'list-units\', \'--all\', \'--type=service\', \'--no-pager\', \'--no-legend\', \'--plain\']) or \'\'\n    patterns = {\'qbittorrent\': \'qbittorrent\', \'rdtclient\': \'rdt\', \'sabnzbd\': \'sabnzbd\', \'lidarr\': \'lidarr\',\n                \'prowlarr\': \'prowlarr\', \'aurral\': \'aurral\', \'slskd\': \'slskd\', \'nzbget\': \'nzbget\'}\n    for line in listed.splitlines():\n        unit = line.split()[0] if line.split() else \'\'\n        if unit.endswith(\'.service\') and patterns.get(role, \'UNMATCHED\') in unit.lower() and unit not in units:\n            units.append(unit)\n    for unit in units[:8]:\n        status, pid, args = service(unit)\n        if status.get(\'LoadState\') == \'not-found\':\n            continue\n        services[unit] = status\n        if pid or not selected_args:\n            selected_pid, selected_args = pid, args\n    output = {\'read_only\': True, \'role\': role, \'services\': services}\n    raw_mounts = json_value(run([\'findmnt\', \'--json\', \'--output\', \'TARGET,SOURCE,FSTYPE,OPTIONS\']), {}) or {}\n    output[\'mounts\'] = flatten_mounts(raw_mounts.get(\'filesystems\'))\n    for mount in output[\'mounts\']:\n        if mount[\'target\'] not in {\'/\'} and len(PATHS) < 40:\n            path_value(mount[\'target\'])\n    output[\'addresses\'] = []\n    for interface in json_value(run([\'ip\', \'-j\', \'address\']), []) or []:\n        if interface.get(\'ifname\') != \'lo\':\n            output[\'addresses\'].append({\'interface\': interface.get(\'ifname\'), \'addresses\': [\n                item.get(\'local\') for item in interface.get(\'addr_info\', []) if item.get(\'scope\') == \'global\']})\n    output[\'routes\'] = [{key: route.get(key) for key in [\'dst\', \'gateway\', \'dev\', \'prefsrc\']} for route in (json_value(run([\'ip\', \'-j\', \'route\']), []) or [])[:40]]\n    listens = run([\'ss\', \'-H\', \'-lnt\']) or \'\'\n    output[\'tcp_listeners\'] = [line.split()[3] for line in listens.splitlines() if len(line.split()) > 3][:100]\n    if role in {\'lidarr\', \'prowlarr\'}:\n        output[\'application\'] = arr_inventory(role, selected_args)\n    elif role == \'aurral\':\n        output[\'application\'] = aurral_inventory(selected_pid)\n    elif role == \'sabnzbd\':\n        output[\'application\'] = sab_inventory(selected_args)\n    elif role == \'qbittorrent\':\n        output[\'application\'] = qb_inventory(selected_args)\n    elif role == \'rdtclient\':\n        output[\'application\'] = rdt_inventory(selected_args)\n    elif role == \'slskd\':\n        output[\'application\'] = slskd_inventory(selected_pid, selected_args)\n    elif role == \'nzbget\':\n        output[\'application\'] = nzbget_inventory(selected_args)\n    output[\'docker\'] = docker_inventory()\n    for path in [\'/downloads\', \'/music\', \'/data\']:\n        PATHS.add(path)\n    if len(PATHS) > 80:\n        WARNINGS.append(\'Directory checks capped at 80; no recursive media scan performed\')\n    output[\'paths\'] = [path_stat(path) for path in sorted(PATHS)[:80]]\n    if output.get(\'application\', {}).get(\'config_not_found\') or output.get(\'application\', {}).get(\'settings_unavailable\'):\n        WARNINGS.append(\'Application configuration was not found in checked locations; inspect service/Docker mount records for a custom path\')\n    output[\'warnings\'] = WARNINGS\n    return scrub(output)\n\n\nif __name__ == \'__main__\':\n    parser = argparse.ArgumentParser(description=__doc__)\n    parser.add_argument(\'--role\', required=True)\n    args = parser.parse_args()\n    try:\n        result = inspect(args.role)\n    except Exception as error:\n        # Never export exception text, which can include credentials/URLs.\n        result = {\'read_only\': True, \'role\': args.role, \'probe_failed\': type(error).__name__}\n    print(json.dumps(scrub(result), separators=(\',\', \':\')))\n'
helpers = types.ModuleType('probe_helpers')
exec(compile(PROBE_SOURCE, '<container-probe>', 'exec'), helpers.__dict__)
ROLES = {'102': 'sabnzbd', '103': 'lidarr', '104': 'nzbget', '106': 'rdtclient',
         '107': 'qbittorrent', '109': 'aurral', '111': 'prowlarr', '117': 'slskd'}


def command(args, timeout=12):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return result.stdout if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def config_fields(text):
    result = {}
    allowed = {'hostname', 'cores', 'memory', 'swap', 'rootfs', 'unprivileged', 'features', 'onboot', 'hookscript', 'lxc.idmap'}
    for line in (text or '').splitlines():
        key, sep, value = line.partition(':')
        if not sep or not (key in allowed or re.fullmatch(r'(mp|net)\d+', key)):
            continue
        if key in result:
            result[key] = [result[key], value.strip()] if not isinstance(result[key], list) else result[key] + [value.strip()]
        else:
            result[key] = value.strip()
    return result


def bind_mounts(config):
    output = []
    for key, text in config.items():
        if not re.fullmatch(r'mp\d+', key) or not isinstance(text, str):
            continue
        pieces = text.split(',')
        opts = dict(part.split('=', 1) for part in pieces[1:] if '=' in part)
        if pieces[0].startswith('/') and opts.get('mp', '').startswith('/'):
            output.append({'slot': key, 'host_path': posixpath.normpath(pieces[0]),
                           'ct_path': posixpath.normpath(opts['mp']), 'read_only': opts.get('ro') == '1'})
    return output


def within(root, candidate):
    if not isinstance(root, str) or not isinstance(candidate, str) or not root.startswith('/') or not candidate.startswith('/'):
        return False
    root = posixpath.normpath(root)
    candidate = posixpath.normpath(candidate)
    return candidate == root or candidate.startswith(root.rstrip('/') + '/')


def translate(path, mounts):
    if not isinstance(path, str) or not path.startswith('/'):
        return None
    eligible = [m for m in mounts if within(m['ct_path'], path)]
    if not eligible:
        return None
    winner = max(eligible, key=lambda m: len(m['ct_path']))
    return posixpath.normpath(posixpath.join(winner['host_path'], posixpath.relpath(path, winner['ct_path'])))


def apply_remote(path, host, mappings):
    matches = [m for m in mappings if isinstance(m, dict) and within(m.get('remotePath'), path)
               and hostname(m.get('host')) == hostname(host) and isinstance(m.get('localPath'), str)]
    if not matches:
        return path, False
    m = max(matches, key=lambda item: len(item['remotePath']))
    return posixpath.normpath(posixpath.join(m['localPath'], posixpath.relpath(path, m['remotePath']))), True


def hostname(value):
    if not value or not isinstance(value, str):
        return None
    try:
        return urllib.parse.urlsplit(value if '://' in str(value) else 'http://' + str(value)).hostname
    except ValueError:
        return None


def host_path_check(path):
    # Directory metadata only. timeout limits waiting on stale network mounts.
    raw = command(['timeout', '4', 'stat', '-L', '-c', '%F|%d|%i|%u|%g|%a', '--', path], timeout=5)
    if raw is None:
        return {'accessible': False, 'reason': 'stat failed or timed out; may be missing, inaccessible, or stale'}
    fields = raw.strip().split('|')
    if len(fields) != 6:
        return {'accessible': None}
    return {'accessible': True, 'type': fields[0], 'device': fields[1], 'inode': fields[2],
            'uid': fields[3], 'gid': fields[4], 'mode': fields[5]}


def ct_config(ctid):
    config = command(['pct', 'config', ctid])
    active = command(['pct', 'config', ctid, '--current', '1'])
    return {'configured': config_fields(config), 'current': config_fields(active) if active else None,
            'config_read_failed': config is None}


def inspect_ct(ctid, status, name, source):
    item = {'name': name, 'status': status, **ct_config(ctid)}
    item['bind_mounts'] = bind_mounts(item.get('current') or item['configured'])
    if ctid in ROLES:
        if status != 'running':
            item['probe'] = {'not_run': 'container is not running; it was left stopped'}
        else:
            print('Reading CT%s (%s)...' % (ctid, ROLES[ctid]), file=sys.stderr, flush=True)
            output = command(['pct', 'exec', ctid, '--', 'python3', '-c', source, '--role', ROLES[ctid]], timeout=110)
            item['probe'] = helpers.json_value(output, {'probe_unavailable': 'Python probe failed or exceeded its time limit; no raw output exported'})
    return ctid, item


def analyze(containers):
    findings = []; aliases = []; paths = []; runtime_groups = []
    binds = [(ctid, mount) for ctid, item in containers.items() for mount in item.get('bind_mounts', [])]
    for (aid, a), (bid, b) in itertools.combinations(binds, 2):
        overlap = b['host_path'] if within(a['host_path'], b['host_path']) else a['host_path'] if within(b['host_path'], a['host_path']) else None
        if overlap is None:
            continue
        apath = posixpath.normpath(posixpath.join(a['ct_path'], posixpath.relpath(overlap, a['host_path'])))
        bpath = posixpath.normpath(posixpath.join(b['ct_path'], posixpath.relpath(overlap, b['host_path'])))
        aliases.append({'host_path': overlap, 'a': {'ct': aid, 'path': apath}, 'b': {'ct': bid, 'path': bpath},
                        'same_container_alias': aid == bid and apath != bpath})
        if aid == bid and apath != bpath:
            findings.append({'kind': 'same_storage_multiple_paths', 'ct': aid,
                'paths': [apath, bpath], 'host_path': overlap,
                'meaning': 'Same host directory exposed at different paths; scanner exclusions need checking. This alone does not prove duplicate files.'})
    for ctid, item in containers.items():
        if item.get('configured') != item.get('current') and item.get('current'):
            findings.append({'kind': 'configured_current_differ', 'ct': ctid, 'meaning': 'Some desired configuration differs from the current configuration; compare both records.'})
        probe = item.get('probe') or {}
        if probe.get('probe_failed') or probe.get('probe_unavailable'):
            findings.append({'kind': 'probe_incomplete', 'ct': ctid})
        physical = {}
        for record in probe.get('paths', []):
            if record.get('exists') and record.get('is_directory'):
                physical.setdefault((record.get('device'), record.get('inode')), []).append(record['path'])
        runtime_groups.extend({'ct': ctid, 'paths': values, 'device': identity[0], 'inode': identity[1]}
                              for identity, values in physical.items() if len(values) > 1)
        for record in probe.get('paths', []):
            canonical = translate(record['path'], item['bind_mounts'])
            paths.append({'ct': ctid, 'path': record['path'], 'host_path_from_bind_config': canonical,
                          'exists': record.get('exists'), 'read_only_bind': next((m['read_only'] for m in sorted(item['bind_mounts'], key=lambda m: -len(m['ct_path'])) if within(m['ct_path'], record['path'])), None)})
            if record.get('stat_error_errno') == 116:
                findings.append({'kind': 'stale_file_handle', 'ct': ctid, 'path': record['path']})
    aurral = (containers.get('109', {}).get('probe') or {}).get('application') or {}
    if (aurral.get('worker') or {}).get('existing_file_mode') == 'download':
        findings.append({'kind': 'aurral_always_download_mode', 'ct': '109', 'meaning': 'Existing-library reuse is disabled; repeated acquisitions can create additional copies.'})
    root = aurral.get('download_folder') or {}
    local = translate(root.get('path'), containers.get('109', {}).get('bind_mounts', []))
    lidarr = (containers.get('103', {}).get('probe') or {}).get('application') or {}
    for folder in lidarr.get('rootfolder', []) if isinstance(lidarr.get('rootfolder'), list) else []:
        lidarr_host = translate(folder.get('path'), containers.get('103', {}).get('bind_mounts', []))
        if local and lidarr_host and (within(lidarr_host, local) or within(local, lidarr_host)):
            findings.append({'kind': 'aurral_lidarr_physical_root_overlap', 'aurral_path': root.get('path'),
                'aurral_host_path': local, 'lidarr_path': folder.get('path'), 'lidarr_host_path': lidarr_host,
                'aurral_path_source': root.get('source'),
                'meaning': 'App roots physically overlap. This requires consistent path naming/exclusions; it is not evidence of an extra physical copy.'})
    return {'findings': findings, 'shared_bind_paths': aliases[:150], 'runtime_same_directory_groups': runtime_groups[:100], 'path_translation_table': paths[:500],
            'shared_bind_paths_truncated': len(aliases) > 150, 'path_translation_table_truncated': len(paths) > 500,
            'sab_lidarr_checks': sab_mapping_checks(containers)}


def sab_mapping_checks(containers):
    lidarr_ct = containers.get('103', {}); sab_ct = containers.get('102', {})
    lidarr = (lidarr_ct.get('probe') or {}).get('application') or {}
    sab = (sab_ct.get('probe') or {}).get('application') or {}
    mappings = lidarr.get('remotepathmapping')
    clients = lidarr.get('downloadclient')
    if not isinstance(mappings, list) or not isinstance(clients, list):
        return [{'not_verified': 'Lidarr API inventory unavailable'}]
    results = []
    for client in clients:
        if str(client.get('implementation', '')).lower() != 'sabnzbd':
            continue
        fields = client.get('fields') or {}; host = fields.get('host')
        categories = [fields.get(k) for k in ['category', 'musicCategory'] if fields.get(k)]
        for category in sab.get('categories', []):
            if categories and category['name'] not in categories:
                continue
            remote = category.get('resolved_folder_if_absolute_base')
            if not remote or not remote.startswith('/'):
                continue
            mapped, applied = apply_remote(remote, host, mappings)
            source = translate(remote, sab_ct.get('bind_mounts', []))
            dest = translate(mapped, lidarr_ct.get('bind_mounts', []))
            results.append({'client': client.get('name'), 'host': host, 'category': category['name'],
                'sab_path': remote, 'lidarr_path_after_mapping': mapped, 'mapping_applied': applied,
                'sab_host_path': source, 'lidarr_host_path': dest,
                'same_host_path': source == dest if source and dest else None,
                'note': 'Configuration comparison only; no import or write-permission test performed.'})
    return results or [{'not_verified': 'No matching SAB client/category configuration found'}]


def markdown(report, json_path):
    lines = ['# N100S music-stack inventory', '', 'UTC capture: ' + report['captured_at_utc'], '',
             'Read-only configuration inventory. No service changes, acquisitions, scans, moves or deletions.', '',
             '## Containers', '', '| CT | Name | State | Detailed application probe |', '|---|---|---|---|']
    for ctid, item in sorted(report['containers'].items(), key=lambda p: int(p[0])):
        probe = item.get('probe') or {}
        state = 'not requested' if ctid not in ROLES else 'incomplete' if probe.get('probe_failed') or probe.get('probe_unavailable') or probe.get('not_run') else 'collected; see JSON for per-app gaps'
        lines.append('| %s | %s | %s | %s |' % (ctid, item['name'], item['status'], state))
    lines += ['', '## Findings', '']
    for finding in report['analysis']['findings']:
        lines.append('- ' + json.dumps(finding, sort_keys=True))
    lines += ['', '## SABnzbd to Lidarr path checks', '']
    for check in report['analysis']['sab_lidarr_checks']:
        lines.append('- ' + json.dumps(check, sort_keys=True))
    lines += ['', '## Scope and limits', '',
              '- Config/mount inventory covers all listed local CTs. App details cover CT102, 103, 104, 106, 107, 109, 111 and 117.',
              '- Credentials and raw configuration/logs are excluded. Internal IPs, directory names, profile names and mounts are retained.',
              '- No recursive media walk, file hashing, duplicate deletion, new baseline or profiling run.',
              '- A matching host path does not prove app-user write access. Directory checks run as the pct-exec probe user.',
              '- Known config locations, explicit CLI config paths and relevant environment values are checked. Custom wrappers or config paths can remain unknown.',
              '- Missing Python, stopped CTs, API/TLS failures and caps are recorded. This inventory does not certify that no duplicates exist.',
              '- Container directory checks can time out on stale network mounts; per-probe timeout is recorded as incomplete.',
              '- No routes/firewall/VPN settings are changed. No external indexer/provider tests are initiated.',
              '', 'Full redacted report: ' + str(json_path), '']
    return '\n'.join(lines)


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Run as root on the Proxmox host.')
    started = time.monotonic()
    raw = command(['pct', 'list'])
    if raw is None:
        raise RuntimeError('Could not list containers with pct.')
    rows = []
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[0].isdigit():
            rows.append((parts[0], parts[1], parts[-1]))
    if not rows:
        raise RuntimeError('No local containers found.')
    source = PROBE_SOURCE
    report = {'inventory_version': '1.0', 'read_only': True,
              'captured_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'host': {}, 'containers': {}}
    report['host']['hostname'] = os.uname().nodename
    report['host']['logical_cpus'] = os.cpu_count()
    report['host']['memory_kib'] = {}
    for line in (helpers.read_text('/proc/meminfo') or '').splitlines():
        key, _, value = line.partition(':')
        if key in {'MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'}:
            report['host']['memory_kib'][key] = int(value.split()[0])
    report['host']['local_disk_usage'] = command(['df', '-Pk', '/', '/var/lib/vz'])
    report['host']['lvm'] = helpers.json_value(command(['lvs', '--reportformat', 'json', '--units', 'b', '-o', 'lv_name,lv_size,data_percent,metadata_percent']), {'unavailable': True})
    mounts = helpers.json_value(command(['findmnt', '--json', '--output', 'TARGET,SOURCE,FSTYPE,OPTIONS']), {}) or {}
    report['host']['mounts'] = helpers.flatten_mounts(mounts.get('filesystems'))
    report['host']['storage_status'] = command(['pvesm', 'status'], timeout=15)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(inspect_ct, ctid, state, name, source) for ctid, state, name in rows]
        for future in concurrent.futures.as_completed(futures):
            ctid, item = future.result()
            report['containers'][ctid] = item
    report['host']['bind_source_checks'] = {}
    sources = sorted({m['host_path'] for item in report['containers'].values() for m in item['bind_mounts']})
    for path in sources[:80]:
        report['host']['bind_source_checks'][path] = host_path_check(path)
    report['host']['bind_source_checks_truncated'] = len(sources) > 80
    report['analysis'] = analyze(report['containers'])
    for path, state in report['host']['bind_source_checks'].items():
        if state.get('accessible') is False:
            report['analysis']['findings'].append({'kind': 'host_bind_source_unavailable', 'host_path': path})
    report['duration_seconds'] = round(time.monotonic() - started, 1)
    os.umask(0o077)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')
    directory = Path(tempfile.mkdtemp(prefix='n100s-music-inventory-' + stamp + '-', dir='/root'))
    target = directory / ('n100s-music-inventory-' + stamp + '.json.gz')
    with gzip.open(target, 'wt', encoding='utf-8') as output:
        json.dump(report, output, indent=2)
    summary = directory / 'README.md'
    summary.write_text(markdown(report, target))
    print('\nInventory complete in %.1f seconds.' % report['duration_seconds'])
    print('Private redacted report: ' + str(target))
    print('Readable summary: ' + str(summary))
    print('Containers: %d; detailed app targets: %d.' % (len(rows), sum(ctid in ROLES for ctid, _, _ in rows)))
    print('Findings: %d. These are configuration observations, not proof of duplicate files.' % len(report['analysis']['findings']))
    print('No production configuration was changed.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Inventory stopped: ' + type(error).__name__ + '. No configuration changes made.', file=sys.stderr)
        sys.exit(1)
