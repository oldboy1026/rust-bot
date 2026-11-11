// Reproducible, narrowly scoped integration fixes to the user-provided sample.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/prepare-plugin.mjs ORIGINAL_SOURCE');
const source = readFileSync(input);
if (createHash('sha256').update(source).digest('hex') !== 'adf0816032fb25194ccbb0daec44e5dd204de261e73398ebd2db6b602973b536') {
  throw new Error('The original AdminLogger 2.5.5 sample hash does not match.');
}
let text = source.toString('utf8').replaceAll('\r\n', '\n');
function replace(before, after) {
  if (!text.includes(before)) throw new Error('Expected patch context missing.');
  text = text.replace(before, after);
}
replace('[Info("Admin Logger", "1AK1", "2.5.5")]',
  '// Local controller integration revision; original author: 1AK1.\n    [Info("Admin Logger", "1AK1", "2.5.6")]');
replace('            Log($"[WS cmd] {name} {payload}");',
  '            Log($"[WS cmd] {name}"); // Never log incoming auth ticket payloads.');
replace('            PurgeExistingForSteamId(steamId);',
  `            // Refuse collisions with real players, including sleeping entities.
            foreach (var existing in BasePlayer.allPlayerList)
            {
                if (existing != null && !existing.IsDestroyed && existing.userID == steamId
                    && !(existing is AdminBot))
                {
                    PrintWarning($"CreateBot refused: existing player entity for {steamId}");
                    return null;
                }
            }
            PurgeExistingForSteamId(steamId);`);
replace('        private bool RemoveBot(ulong steamId, bool silent = false)',
  '        private bool RemoveBot(ulong steamId, bool silent = false, bool preserveSteamSession = false)');
replace('                    RemoveBot(t.id, silent: true);',
  '                    RemoveBot(t.id, silent: true, preserveSteamSession: true);');
replace('            var player = botInfo.Player;\n            if (player == null || player.IsDestroyed)',
  '            // Remove ownership before Kill so its death hook cannot schedule a new spawn.\n            _bots.Remove(steamId);\n            var player = botInfo.Player;\n            if (player == null || player.IsDestroyed)');
replace('            timer.Once(3f, () => RespawnBot(steamId));',
  `            timer.Once(3f, () =>
            {
                // A delayed death callback must not respawn a newer same-ID lease.
                if (_bots.TryGetValue(steamId, out var current) && ReferenceEquals(current.Player, player))
                    RespawnBot(steamId);
            });`);
replace('                if (botInfo.HasSteamSession)\n                    try { EndSteamSession(steamId); } catch { }',
  '                // Failed validation also requires closing the server auth session.\n                if (!preserveSteamSession) try { EndSteamSession(steamId); } catch { }');
replace('            if (botInfo.HasSteamSession)\n                try { EndSteamSession(steamId); } catch { }',
  '            // Also close failed/pending sessions, except explicit in-place recreation.\n            if (!preserveSteamSession) try { EndSteamSession(steamId); } catch { }');
replace('            bool hadSteamSession = botInfo.HasSteamSession;',
  '            bool hadSteamSession = botInfo.HasSteamSession;\n            string savedTicketHex = botInfo.AuthTicketHex;');
replace('                _bots[steamId].HasSteamSession = hadSteamSession;',
  '                _bots[steamId].HasSteamSession = hadSteamSession;\n                _bots[steamId].AuthTicketHex = savedTicketHex;');
replace('                        return new { ok = BeginSteamSession(steamId, ticketHex) };',
  `                        EndSteamSession(steamId);
                        _bots[steamId].HasSteamSession = false;
                        bool refreshed = BeginSteamSession(steamId, ticketHex);
                        if (refreshed) _bots[steamId].AuthTicketHex = ticketHex;
                        return new { ok = refreshed };`);
replace('                    connected_seconds = alive && p.net?.connection != null\n                        ? (int)p.net.connection.GetSecondsConnected() : 0,',
  '                    connected_seconds = alive\n                        ? Math.Max(0, (int)(TimeEx.realtimeSinceStartup - info.OriginalConnectionTime)) : 0,');
replace('            private readonly object _lock = new object();',
  '            private readonly object _lock = new object();\n            private readonly SemaphoreSlim _sendGate = new SemaphoreSlim(1, 1);');
replace('                _cts = new CancellationTokenSource();\n                _runLoopTask = Task.Run(() => RunLoopAsync(_cts.Token));',
  '                _cts = new CancellationTokenSource();\n                var startToken = _cts.Token;\n                _runLoopTask = Task.Run(() => RunLoopAsync(startToken));');
replace(`                    var json = JsonConvert.SerializeObject(msg);
                    var bytes = Encoding.UTF8.GetBytes(json);
                    await _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, _cts.Token);`,
  '                    await SendRawAsync(msg);');
replace(`                var json = JsonConvert.SerializeObject(msg);
                var bytes = Encoding.UTF8.GetBytes(json);
                await _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, _cts.Token);`,
  `                var socket = _ws;
                var token = _cts.Token;
                await _sendGate.WaitAsync(token);
                try
                {
                    if (socket == null || socket != _ws || socket.State != WebSocketState.Open) return;
                    var json = JsonConvert.SerializeObject(msg);
                    var bytes = Encoding.UTF8.GetBytes(json);
                    await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, token);
                }
                finally { _sendGate.Release(); }`);
writeFileSync(new URL('../plugin/AdminLogger.cs', import.meta.url), text.replaceAll('\n', '\r\n'));
console.log('Prepared AdminLogger 2.5.6 integration copy; original source unchanged.');
