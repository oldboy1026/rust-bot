using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Net.WebSockets;
using System.Reflection;
using System.Reflection.Emit;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Facepunch;
using HarmonyLib;
using Network;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Oxide.Core;
using Oxide.Core.Plugins;
using Rust.Ai;
using Steamworks;
using UnityEngine;
using UnityEngine.AI;

namespace Oxide.Plugins
{
    // Local controller integration revision; original author: 1AK1.
    [Info("Admin Logger", "1AK1", "2.5.9")]
    [Description("Logs admin commands usage in a file and console")]
    public class AdminLogger : RustPlugin
    {
        #region Config

        private class PluginConfig
        {
            [JsonProperty("debug")]
            public bool Debug { get; set; } = false;

            // Controller base URL. Used for HTTP plugin update endpoints
            // (/api/plugin/hash, /api/plugin/download). Event transport is
            // WebSocket-only — no legacy webhook fallback.
            [JsonProperty("controllerUrl")]
            public string ControllerUrl { get; set; } = "https://controller.rust-x.io";

            // WebSocket pairing (set via `admin.pair <key> <wsUrl>` once).
            // Plugin connects out to the controller over this URL and uses
            // PairKey as Bearer auth. Events and commands flow over this
            // channel with ack/outbox delivery guarantees.
            [JsonProperty("wsUrl")]
            public string WsUrl { get; set; } = "";

            [JsonProperty("pairKey")]
            public string PairKey { get; set; } = "";

            // Sleeper spawn percentage (retained for config compatibility).
            [JsonProperty("sleeperPercent")]
            public int SleeperPercent { get; set; } = 30;

            // When true, postfix Facepunch.Rust.Analytics.Azure.On{PlayerConnected,
            // PlayerDisconnected,SteamAuth} and dump each server-side analytics
            // event Rust submits to Facepunch (steam_auth / player_connect /
            // player_disconnect) with a millisecond UTC timestamp — to console,
            // a dated JSONL file under oxide/logs/AdminLogger/, and the
            // controller over WS (event type "fp_server_event"). Captures REAL
            // events only: our own bot emit path calls EventRecord directly and
            // does not go through Azure.On*. Kill-switch for noisy servers.
            [JsonProperty("dumpFacepunchServerEvents")]
            public bool DumpFacepunchServerEvents { get; set; } = true;
        }

        private PluginConfig _config;

        // Carbon Mod detection — Carbon shims Oxide.Core APIs but ships its own
        // HarmonyX, plugin directory layout (carbon/plugins, carbon/data) and a
        // Roslyn-based ScriptWatcher. We branch on this for a few subtle places
        // where Oxide and Carbon behave differently (auto-update file writes,
        // HarmonyLoader patches that have no effect under Carbon).
        private static readonly bool IsCarbon =
            Type.GetType("Carbon.Community, Carbon.Common") != null ||
            Type.GetType("Carbon.Bootstrap, Carbon") != null;

        // Resolve the directory Carbon/Oxide actually loads plugins from. Under
        // Oxide this is `oxide/plugins/`; under Carbon it's `carbon/plugins/`.
        // `Interface.Oxide.PluginDirectory` is shimmed by Carbon but we go via
        // `Carbon.Defines.GetScriptFolder()` reflection if available so we are
        // resilient to shim regressions.
        private static string ResolvePluginDirectory()
        {
            if (IsCarbon)
            {
                try
                {
                    var defines = Type.GetType("Carbon.Defines, Carbon.Common")
                                  ?? Type.GetType("Carbon.Defines, Carbon");
                    var m = defines?.GetMethod("GetScriptFolder",
                        BindingFlags.Public | BindingFlags.Static);
                    var result = m?.Invoke(null, null) as string;
                    if (!string.IsNullOrEmpty(result)) return result;
                }
                catch { }
            }
            return Interface.Oxide.PluginDirectory;
        }

        // One-shot migration of the persistent WS outbox from oxide/data into
        // carbon/data when a server operator switches loaders. We only copy
        // when the legacy file exists AND the new-location file doesn't, so
        // re-running under Oxide later doesn't clobber a fresher Carbon file.
        // Idempotent: invoked from WsClient.LoadOutbox before its ReadObject.
        private bool _outboxMigrationAttempted;
        private void MigrateLegacyOutboxIfNeeded()
        {
            if (_outboxMigrationAttempted) return;
            _outboxMigrationAttempted = true;

            if (!IsCarbon) return; // only relevant when reading from carbon/data

            try
            {
                if (Interface.Oxide.DataFileSystem.ExistsDatafile("AdminLogger/outbox"))
                    return; // carbon/data/AdminLogger/outbox.json already present

                // Try to locate oxide/data/AdminLogger/outbox.json by walking
                // up from carbon's data dir to the Rust dedicated server root
                // and probing the conventional Oxide layout.
                string carbonDataDir = Interface.Oxide.DataDirectory;
                if (string.IsNullOrEmpty(carbonDataDir)) return;

                // dataDir for Carbon looks like ".../carbon/data" — go up to the
                // server root and resolve "oxide/data" sibling.
                var carbonRoot = System.IO.Directory.GetParent(carbonDataDir)?.Parent;
                if (carbonRoot == null) return;
                var legacyOutbox = System.IO.Path.Combine(carbonRoot.FullName,
                    "oxide", "data", "AdminLogger", "outbox.json");
                if (!System.IO.File.Exists(legacyOutbox)) return;

                var carbonOutboxDir = System.IO.Path.Combine(carbonDataDir, "AdminLogger");
                System.IO.Directory.CreateDirectory(carbonOutboxDir);
                var carbonOutbox = System.IO.Path.Combine(carbonOutboxDir, "outbox.json");
                System.IO.File.Copy(legacyOutbox, carbonOutbox, overwrite: false);
                Puts($"[WS] Outbox migrated from {legacyOutbox} → {carbonOutbox}");
            }
            catch (Exception ex)
            {
                PrintWarning($"[WS] Outbox migration skipped: {ex.Message}");
            }
        }

        protected override void LoadDefaultConfig()
        {
            _config = new PluginConfig();
        }

        protected override void LoadConfig()
        {
            base.LoadConfig();
            try
            {
                _config = Config.ReadObject<PluginConfig>();
                if (_config == null) throw new Exception();
            }
            catch
            {
                PrintWarning("Invalid config, creating default");
                _config = new PluginConfig();
            }

            SaveConfig();
        }

        protected override void SaveConfig() => Config.WriteObject(_config);

        private void Log(string msg)
        {
            if (_config?.Debug == true)
                Puts($"[DEBUG] {msg}");
        }

        private Dictionary<string, string> ServerAuthHeaders()
        {
            var headers = new Dictionary<string, string>();
            // Single source of truth: pair key as Bearer for HTTP update
            // endpoints. Same key the WebSocket transport uses.
            if (!string.IsNullOrEmpty(_config?.PairKey))
                headers["Authorization"] = "Bearer " + _config.PairKey;
            try
            {
                var steamId = Steamworks.SteamServer.SteamId;
                if (steamId.Value != 0)
                    headers["X-Server-SteamID"] = steamId.ToString();
            }
            catch { }
            return headers;
        }

        // List of plugin file names (without path) that AdminPanel owns and keeps
        // in sync with the controller. The loop checks the hash of each against
        // the server copy and re-downloads if different. Oxide auto-reloads any
        // .cs file written into oxide/plugins/.
        private static readonly string[] ManagedPluginFiles = new[]
        {
            "AdminLogger.cs",
        };

        // Config files synced to oxide/config/ (same hash+download mechanism).
        // Unlike plugins, config files do NOT trigger auto-reload — the plugin
        // reads them on demand or on server init.
        private static readonly string[] ManagedConfigFiles = new string[0];

        private void CheckForUpdate(bool applyUpdate = false)
        {
            if (string.IsNullOrEmpty(_config?.ControllerUrl)) return;
            if (string.IsNullOrEmpty(_config?.PairKey))
            {
                Log("update: not paired, skipping (run admin.pair to enable updates)");
                return;
            }
            var baseUrl = _config.ControllerUrl.TrimEnd('/');
            foreach (var file in ManagedPluginFiles)
                CheckSingleFileUpdate(baseUrl, file, ResolvePluginDirectory(), applyUpdate);
            foreach (var file in ManagedConfigFiles)
                CheckSingleFileUpdate(baseUrl, file, Interface.Oxide.ConfigDirectory, applyUpdate);
        }

        private void CheckSingleFileUpdate(string baseUrl, string fileName, string targetDir, bool applyUpdate)
        {
            var hashUrl = $"{baseUrl}/api/plugin/hash?name={fileName}";
            var localPath = targetDir + "/" + fileName;

            try
            {
                webrequest.Enqueue(hashUrl, null, (code, response) =>
                {
                    if (code != 200)
                    {
                        Puts($"Update check failed for {fileName}: HTTP {code}");
                        return;
                    }

                    var remoteHash = JsonConvert.DeserializeObject<Dictionary<string, string>>(response)?["hash"];
                    if (string.IsNullOrEmpty(remoteHash)) return;

                    string localHash = "<missing>";
                    if (System.IO.File.Exists(localPath))
                    {
                        var localBytes = System.IO.File.ReadAllBytes(localPath);
                        localHash = BitConverter.ToString(
                            System.Security.Cryptography.SHA256.Create().ComputeHash(localBytes)
                        ).Replace("-", "").ToLower();
                    }

                    if (localHash == remoteHash)
                    {
                        // Only log "up to date" for manual rne.update to give
                        // the operator visible feedback. Periodic 300s checks
                        // stay silent (they'd spam the console).
                        if (applyUpdate) Puts($"{fileName} is up to date");
                        else Log($"{fileName} is up to date");
                        return;
                    }

                    // Force download when the file is missing locally —
                    // this covers fresh game-server installs.
                    bool missing = localHash == "<missing>";
                    if (applyUpdate || missing)
                    {
                        Puts($"{(missing ? "Missing" : "Update found for")} {fileName}, downloading…");
                        DownloadSingleFileUpdate(baseUrl, fileName, localPath);
                    }
                    else
                    {
                        Puts($"[UPDATE] New version of {fileName} available. Will be applied on next rne.update / server restart.");
                    }

                }, this, Oxide.Core.Libraries.RequestMethod.GET, ServerAuthHeaders());
            }
            catch (Exception ex)
            {
                PrintError($"Update check exception for {fileName}: {ex.Message}");
            }
        }

        private void DownloadSingleFileUpdate(string baseUrl, string fileName, string localPath)
        {
            var downloadUrl = $"{baseUrl}/api/plugin/download?name={fileName}";

            try
            {
                webrequest.Enqueue(downloadUrl, null, (code, response) =>
                {
                    if (code != 200 || string.IsNullOrEmpty(response))
                    {
                        PrintWarning($"Update download failed for {fileName}: HTTP {code}");
                        return;
                    }

                    // Mono's FileSystemWatcher on Linux is unreliable for ANY
                    // write strategy (we tried Delete+Move → Renamed event
                    // ignored; tried tmp+Copy(overwrite) → Oxide still didn't
                    // pick up the change). Instead of fighting the watcher,
                    // we write directly and trigger an explicit reload via
                    // Interface.Oxide.ReloadPlugin below.
                    //
                    // Carbon: keep the tmp+Copy dance — Carbon's Roslyn
                    // compiler scans the file as it sees IN_MODIFY events
                    // and can choke on partial writes. The tmp ensures the
                    // final file appears atomically from Carbon's POV.
                    bool isConfig = localPath.Contains(Interface.Oxide.ConfigDirectory);
                    try
                    {
                        if (IsCarbon)
                        {
                            var tmpPath = localPath + ".tmp";
                            System.IO.File.WriteAllText(tmpPath, response);
                            try
                            {
                                System.IO.File.Copy(tmpPath, localPath, overwrite: true);
                                System.IO.File.Delete(tmpPath);
                            }
                            catch
                            {
                                try { if (System.IO.File.Exists(localPath)) System.IO.File.Delete(localPath); } catch { }
                                System.IO.File.Move(tmpPath, localPath);
                            }
                        }
                        else
                        {
                            // Oxide: direct write. Single open(O_TRUNC|O_WRONLY)
                            // → write → close — produces one IN_MODIFY event.
                            // Reload is triggered explicitly anyway, so we
                            // don't depend on the watcher seeing it.
                            System.IO.File.WriteAllText(localPath, response);
                        }
                    }
                    catch (Exception ex)
                    {
                        PrintError($"Update write failed for {fileName}: {ex.Message}");
                        return;
                    }

                    string loaderName = IsCarbon ? "Carbon" : "Oxide";
                    Puts($"{fileName} updated! ({response.Length} bytes)");

                    // Force the reload ourselves rather than waiting for the
                    // file watcher (which has been observed not to fire on
                    // Mono Linux even after WriteAllText). Defer ~2s so:
                    //   1. Filesystem buffers flush (mtime resolution),
                    //   2. If the watcher DID fire, its reload completes
                    //      first and our timer dies with the old instance,
                    //      so we don't double-reload.
                    //   3. We exit the webrequest callback context cleanly.
                    // Config files don't need reload — plugins read them on
                    // demand or on the next plugin reload cycle.
                    if (!isConfig)
                    {
                        string pluginName = System.IO.Path.GetFileNameWithoutExtension(fileName);
                        timer.Once(2f, () =>
                        {
                            try
                            {
                                bool ok = Interface.Oxide.ReloadPlugin(pluginName);
                                Puts($"[UPDATE] {loaderName} reload {pluginName}: {(ok ? "OK" : "no-op (already reloaded by watcher, or plugin name mismatch)")}");
                            }
                            catch (Exception ex)
                            {
                                PrintError($"Reload {pluginName} failed: {ex.Message}");
                            }
                        });
                    }

                }, this, Oxide.Core.Libraries.RequestMethod.GET, ServerAuthHeaders());
            }
            catch (Exception ex)
            {
                PrintError($"Update download exception for {fileName}: {ex.Message}");
            }
        }

        private void DownloadUpdate() { /* legacy entry — kept for compatibility with admin.update */ CheckForUpdate(applyUpdate: true); }

        #endregion

        private class BotInfo
        {
            public BasePlayer Player;            // CustomPet or AdminBot — both BasePlayer-compatible
            public string DisplayName;
            public string IpAddress;
            public double OriginalConnectionTime;
            public bool HasSteamSession;
            public string AuthTicketHex;         // cached for respawn re-auth
            public int BasePing;                 // stable base ping (assigned once) + tiny jitter at read
            public int DeathCount;               // incremented on bot death
            public int KillCount;                // reserved for future bot-kill-player tracking
        }

        // Returns a stable fake ping for a bot with small per-read jitter
        // (~±3ms). Looks natural vs. wild 30-120 random every query.
        private static int GetBotDisplayPing(BotInfo bi)
        {
            if (bi == null) return UnityEngine.Random.Range(40, 91);
            if (bi.BasePing <= 0) bi.BasePing = UnityEngine.Random.Range(40, 91);
            int jitter = UnityEngine.Random.Range(-3, 4);
            int v = bi.BasePing + jitter;
            if (v < 15) v = 15;
            return v;
        }

        private Dictionary<ulong, BotInfo> _bots = new Dictionary<ulong, BotInfo>();
        private class AuthTrace
        {
            public string AttemptId;
            public string Fingerprint;
        }
        private readonly Dictionary<ulong, AuthTrace> _authTraces = new Dictionary<ulong, AuthTrace>();
        private readonly Queue<ulong> _authTraceOrder = new Queue<ulong>();
        private static AdminLogger _instance;
        private Harmony _harmony;

        // Диагностика steam-auth при массовом register. BeginAuthSession принимается
        // СИНХРОННО (true = тикет взят в проверку), но реальный ответ Steam приходит
        // АСИНХРОННО через OnValidateAuthTicketResponse — и player_connect (→ playerCount)
        // эмитится ТОЛЬКО там при Status==OK. Если на пачку из 20 register'ов Steam
        // отвечает OK не на всех (rate-limit/задержка/невалидный тикет) — в playerCount
        // попадут только ответившие. begun vs ok/fail = прямой замер «20 зарегали → 6».
        private int _steamAuthBegun;
        private int _steamAuthRespOk;
        private int _steamAuthRespFail;
        private readonly Dictionary<ulong, double> _steamAuthBeginAt = new Dictionary<ulong, double>();

        // Reflection cache
        private FieldInfo _netSubscriberField;
        private FieldInfo _userIdField;
        private FieldInfo _encryptedValueField;
        private FieldInfo _displayNameField;
        private FieldInfo _displayNameEncryptedField;
        private PropertyInfo _displayNameProperty;
        private FieldInfo _lastTickTimeField;
        private Timer _keepAliveTimer;
        private Timer _updateTimer;
        private Timer _wsHbTimer;
        private Timer _logRotateTimer;
        private Timer _envTickTimer;
        private Timer _worldMetadataTimer;

        // Hard cap on the size of any *.log file in the server's `logs/`
        // directory. If the dedicated server (or a misbehaving plugin) starts
        // spamming a log file we truncate it in-place before it can fill the
        // disk. 1 GiB leaves plenty of room for normal post-mortem inspection
        // while still preventing 200+ GiB pathological growth like we saw
        // when the bot Player Update NRE caskade ran for 11 hours.
        private const long LogRotateMaxBytes = 1024L * 1024L * 1024L;
        private string _pluginPath;

        #region Oxide Hooks

        void Init()
        {
            _instance = this;
            CacheReflection();
            PatchPing();
            Log($"[Reflection] displayName field: {_displayNameField?.FieldType.FullName ?? "null"}, property: {_displayNameProperty?.PropertyType.FullName ?? "null"}");
            Log($"[Reflection] lastTickTime: {(_lastTickTimeField != null ? "OK" : "FAIL")}");

            // Hot-reload path: if the server is already running (plugin was
            // reloaded, not fresh server start), OnServerInitialized won't
            // fire again — run the proactive cleanup now. For cold start,
            // OnServerInitialized handles it.
            if (ServerMgr.Instance != null && BaseNetworkable.serverEntities != null)
            {
                try { ProactiveCleanupStaleSubscribers(); }
                catch (Exception ex) { PrintWarning($"ProactiveCleanup on Init: {ex.Message}"); }
            }

            _pluginPath = ResolvePluginDirectory() + "/AdminLogger.cs";

            // Periodic update check only — no auto-apply. Manual apply via admin.update.
            _updateTimer = timer.Every(300f, () => CheckForUpdate(applyUpdate: false));

            // WebSocket heartbeat — every 15s, well under the controller's 90s staleness threshold.
            _wsHbTimer = timer.Every(15f, () => { try { _ws?.SendHeartbeat(); } catch { } });

            // Periodic log rotation to keep runaway dedicated-server log spam
            // (e.g. NRE per-tick) from filling the disk.
            _logRotateTimer = timer.Every(60f, RotateOversizedLogs);

            // env.time / env.daylength push: контроллеру нужен server-side
            // day-night cycle для расчёта analytics поля `time_of_day` (см.
            // BuildHelloPayload comment + MITM reverse 2026-05-29). Period 60s —
            // env.time меняется ~1 in-game hour за 2.5 real-minutes при daylength=60.
            _envTickTimer = timer.Every(60f, EmitEnvTick);

            // World and asset dependency data must only be read on the game thread.
            // The WebSocket hello uses the cache; reconcile also refreshes it here.
            RefreshWorldMetadata();
            _worldMetadataTimer = timer.Every(30f, RefreshWorldMetadata);

            // Keep bots alive: update lastTickTime every 15s to prevent "Unresponsive" kick.
            // If reflection failed to resolve the field, skip the timer entirely.
            if (_lastTickTimeField == null)
            {
                PrintWarning("KeepAlive disabled: lastTickTime field not found — bots may be kicked as Unresponsive");
            }
            else
            {
                _keepAliveTimer = timer.Every(15f, () =>
                {
                    if (_bots.Count == 0) return;
                    float now = UnityEngine.Time.time;
                    foreach (var kvp in _bots)
                    {
                        var player = kvp.Value.Player;
                        if (player != null && !player.IsDestroyed)
                            _lastTickTimeField.SetValue(player, now);
                    }
                });
            }
        }

        void OnServerInitialized()
        {
            _worldMetadataNextCheck = 0d;
            RefreshWorldMetadata();
            // Start the WebSocket client if already paired. Send plugin_init event —
            // controller will use it to kick off reconcile for this server.
            if (!string.IsNullOrEmpty(_config.PairKey) && !string.IsNullOrEmpty(_config.WsUrl))
            {
                if (_ws == null)
                {
                    _ws = new WsClient(this);
                    _ws.LoadOutbox();
                    _ws.Start();
                }
                Puts($"WS client: paired to {_config.WsUrl}");
            }
            else
            {
                Puts("");
                Puts("====================================================================");
                Puts("NOT PAIRED to controller. To pair, run in RCON:");
                Puts("    rne.pair <pairKey> <wsUrl>");
                Puts("");
                Puts("  <pairKey>: generated by the controller UI when you add this server");
                Puts("  <wsUrl>: e.g. ws://controller.example.com:9000/ws");
                Puts("           or  wss://controller.example.com/ws  (TLS)");
                Puts("");
                Puts("  Until paired, events stay in local outbox.");
                Puts("====================================================================");
                Puts("");
            }
            SendEvent(0, "plugin_init", GetServerInfoJson());

            // One-shot cleanup of stale Visibility.Group.subscribers entries.
            // Game-world state survives plugin reloads AND map wipes (only a
            // full server process restart clears it). Walk every serverEntity
            // once and strip null / inactive Connection entries from their
            // network-group subscriber lists.
            ProactiveCleanupStaleSubscribers();

            // Kick off an immediate update check.
            try { CheckForUpdate(applyUpdate: false); }
            catch (Exception ex) { PrintWarning($"Initial update check failed: {ex.Message}"); }

            // Patch any third-party plugins that were loaded BEFORE us — for
            // those Oxide doesn't fire OnPluginLoaded, so we must scan now.
            try { PatchAlreadyLoadedThirdPartyPlugins(); }
            catch (Exception ex) { PrintWarning($"PatchAlreadyLoadedThirdPartyPlugins: {ex.Message}"); }
        }

        private void PatchAlreadyLoadedThirdPartyPlugins()
        {
            foreach (var pluginName in _skipForBotsPlugins)
            {
                var p = plugins?.Find(pluginName);
                if (p != null) TryPatchThirdPartyBotCrash(p);
            }
        }

        private static bool _cleanupDone;
        private void ProactiveCleanupStaleSubscribers()
        {
            if (_cleanupDone) return;
            _cleanupDone = true;
            int scanned = 0;
            int cleaned = 0;
            var seenGroups = new HashSet<Network.Visibility.Group>();
            try
            {
                foreach (var entity in BaseNetworkable.serverEntities)
                {
                    scanned++;
                    Network.Visibility.Group grp = null;
                    try { grp = entity?.net?.group; }
                    catch { continue; }
                    if (grp == null) continue;
                    if (!seenGroups.Add(grp)) continue; // dedupe per group
                    var subs = grp.subscribers;
                    if (subs == null || subs.Count == 0) continue;
                    try
                    {
                        for (int i = subs.Count - 1; i >= 0; i--)
                        {
                            var c = subs[i];
                            if (c == null || !c.active)
                            {
                                subs.RemoveAt(i);
                                cleaned++;
                            }
                        }
                    }
                    catch { }
                }
            }
            catch (Exception ex) { PrintWarning($"ProactiveCleanup: {ex.Message}"); }
            Puts($"ProactiveCleanup: scanned {scanned} entities, {seenGroups.Count} unique groups, removed {cleaned} stale subscriber entries");
        }

        void Unload()
        {
            _updateTimer?.Destroy();
            _updateTimer = null;
            _keepAliveTimer?.Destroy();
            _keepAliveTimer = null;
            _wsHbTimer?.Destroy();
            _wsHbTimer = null;
            _logRotateTimer?.Destroy();
            _logRotateTimer = null;
            _envTickTimer?.Destroy();
            _envTickTimer = null;
            _worldMetadataTimer?.Destroy();
            _worldMetadataTimer = null;

            try { _ws?.Stop(); } catch { }
            _ws = null;

            foreach (var kvp in new Dictionary<ulong, BotInfo>(_bots))
            {
                RemoveBot(kvp.Key, silent: true, reason: "plugin_unload");
            }
            _bots.Clear();

            _harmony?.UnpatchAll("com.1ak1.adminlogger");
            _harmony = null;
            _instance = null;
        }

        // Truncate any *.log file in the dedicated server's `logs/` directory
        // that has exceeded LogRotateMaxBytes. Uses SetLength(0) with shared
        // read/write so we don't fight the open FD held by RustDedicated —
        // the kernel keeps the FD valid; subsequent writes resume at the old
        // offset (creating a sparse hole), but the on-disk allocation drops to
        // zero immediately, which is exactly what saves the disk.
        void RotateOversizedLogs()
        {
            try
            {
                if (!Directory.Exists("logs")) return;
                foreach (var path in Directory.GetFiles("logs", "*.log"))
                {
                    long size;
                    try { size = new FileInfo(path).Length; }
                    catch { continue; }
                    if (size <= LogRotateMaxBytes) continue;
                    try
                    {
                        using (var fs = new FileStream(path, FileMode.Open, FileAccess.Write,
                                                       FileShare.ReadWrite | FileShare.Delete))
                        {
                            fs.SetLength(0);
                        }
                        PrintWarning($"[Logrotate] truncated {path} (was {size} bytes, cap {LogRotateMaxBytes})");
                    }
                    catch (Exception ex)
                    {
                        PrintWarning($"[Logrotate] truncate {path} failed: {ex.Message}");
                    }
                }
            }
            catch (Exception ex)
            {
                PrintWarning($"[Logrotate] scan error: {ex.Message}");
            }
        }

        void OnEntityDeath(BaseCombatEntity entity, HitInfo info)
        {
            var player = entity as BasePlayer;
            if (player == null) return;

            ulong steamId = player.userID;
            if (!_bots.TryGetValue(steamId, out var botInfo)) return;

            // Immediately stop networking to prevent NullRef cascades during the death process
            player.limitNetworking = true;

            string killer = info?.InitiatorPlayer?.displayName ?? "unknown";
            Puts($"Bot {botInfo.DisplayName} ({steamId}) killed by {killer}, respawning...");
            Log($"Death details: hp={player.health}, lifestate={player.lifestate}, limitNet={player.limitNetworking}");
            SendEvent(steamId, "bot_killed", killer);

            // Delay respawn to let death process complete
            timer.Once(3f, () =>
            {
                // A delayed death callback must not respawn a newer same-ID lease.
                if (_bots.TryGetValue(steamId, out var current) && ReferenceEquals(current.Player, player))
                    RespawnBot(steamId);
            });
        }

        // True iff entity is one of our sleeper-bots. O(1) dictionary lookup.
        private bool IsOurBot(BaseEntity e)
        {
            var bp = e as BasePlayer;
            if (bp == null) return false;
            return _bots.ContainsKey(bp.userID);
        }

        // Block vanilla Rust AI (animals, scientists, humanNPCs, heliNPCs) from
        // picking our sleeper-bots as PrimaryTarget. Returning non-null cancels.
        object OnNpcTarget(BaseEntity npc, BaseEntity target)
        {
            return IsOurBot(target) ? (object)true : null;
        }

        // Block auto-turrets, SAM sites and patrol heli target scanner.
        // Returning false explicitly blocks the target.
        object CanBeTargeted(BaseCombatEntity target, MonoBehaviour behaviour)
        {
            return IsOurBot(target) ? (object)false : null;
        }

        // Defense-in-depth: if any AoE / ricochet / non-standard damage path
        // still hits our bot from an NPC source, zero out the damage. Leaves
        // suicide / fall / metabolism damage working so respawn loop unaffected.
        object OnEntityTakeDamage(BaseCombatEntity entity, HitInfo info)
        {
            if (info == null || !IsOurBot(entity)) return null;
            var init = info.Initiator;
            if (init is BaseNpc || init is BaseAnimalNPC || init is global::HumanNPC ||
                init is NPCPlayer || init is AutoTurret || init is BaseHelicopter ||
                init is PatrolHelicopter)
            {
                info.damageTypes.Clear();
            }
            return null;
        }

        #endregion

        #region Harmony Patches

        private void PatchPing()
        {
            try
            {
                // Defensive: clean any stale patches from previous plugin loads
                // that may have failed to unload properly (server process kept
                // running across wipes). Harmony detours persist across plugin
                // reloads until the game process restarts.
                try { new Harmony("com.1ak1.adminlogger").UnpatchAll("com.1ak1.adminlogger"); } catch { }
                _harmony = new Harmony("com.1ak1.adminlogger");

                // 1. Patch GetAveragePing — fake ping for bots
                var serverType = Network.Net.sv.GetType();

                // Must use DeclaredOnly to get the Raknet override, not the base virtual
                var method = serverType.GetMethod("GetAveragePing",
                    BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly);

                // Fallback: search all methods including inherited
                if (method == null)
                    method = serverType.GetMethod("GetAveragePing",
                        BindingFlags.Public | BindingFlags.Instance);

                if (method == null)
                {
                    PrintWarning("GetAveragePing not found on " + serverType.FullName);
                }
                else
                {
                    var prefix = typeof(AdminLogger).GetMethod(nameof(PingPrefix),
                        BindingFlags.NonPublic | BindingFlags.Static);
                    _harmony.Patch(method, prefix: new HarmonyMethod(prefix));
                    Log($"Harmony: patched {serverType.FullName}.{method.Name}");
                }

                // Guard BasePlayer.RemoveFromPlayerCache against double-removal.
                // In Rust v2624+ the per-player tick moved fully into the Unity
                // job system (ConnectedPlayersUpdate over ReadOnlySpan<BasePlayer>)
                // with no per-instance hook Harmony can intercept. The crash
                //   "Player not in the PlayerCache!"
                //   "Server Exception: Player Update"
                //   IndexOutOfRangeException
                // happens when RemoveFromPlayerCache is called a SECOND time on a
                // bot whose ActivePlayerInd was already reset to -1 by the first
                // call (first call: normal Rust disconnect; second call: plugin
                // respawn cleanup). The second call passes -1 to GetIndexForSyncRemove
                // which yields a bad array index → crash.
                // Making RemoveFromPlayerCache a no-op when ActivePlayerInd == -1
                // is the minimal fix — it's already been removed, nothing to do.
                try
                {
                    // The Aug-2026 build changed the signature to
                    //   RemoveFromPlayerCache(BasePlayer, ref PlayerServerStates)
                    // — a second parameter was appended. An exact-signature
                    // GetMethod for `(BasePlayer)` returns null on this build,
                    // silently dropping the guard. Match by name + first-param
                    // type so any appended trailing parameter can't unbind us;
                    // the prefix only needs the BasePlayer arg (Harmony binds it
                    // by name "player").
                    MethodInfo rfpc = null;
                    foreach (var m in typeof(BasePlayer).GetMethods(
                        BindingFlags.NonPublic | BindingFlags.Static))
                    {
                        if (m.Name != "RemoveFromPlayerCache") continue;
                        var ps = m.GetParameters();
                        if (ps.Length >= 1 && ps[0].ParameterType == typeof(BasePlayer))
                        {
                            rfpc = m;
                            break;
                        }
                    }
                    var rfpcPrefix = typeof(AdminLogger).GetMethod(nameof(RemoveFromPlayerCachePrefix),
                        BindingFlags.NonPublic | BindingFlags.Static);
                    if (rfpc != null && rfpcPrefix != null)
                    {
                        _harmony.Patch(rfpc, prefix: new HarmonyMethod(rfpcPrefix));
                        Log("Harmony: patched BasePlayer.RemoveFromPlayerCache (idempotent guard)");
                    }
                    else
                    {
                        PrintWarning($"RemoveFromPlayerCache patch: method={rfpc != null}, prefix={rfpcPrefix != null}");
                    }
                }
                catch (Exception ex) { PrintWarning($"Patch RemoveFromPlayerCache: {ex.Message}"); }

                // 4c-6. Hide our Harmony mod from Facepunch analytics.
                // Rust periodically calls HarmonyLoader.GetHarmonyMods() and
                // POSTs the result to rust-api.facepunch.com as part of the
                // server_performance event (PerformanceLogging.cs:349-354).
                // We attach a postfix that filters out any entry whose
                // AssemblyName matches our id — FP sees every other mod
                // except ours, `harmony_mod_count` is silently decremented.
                //
                // Under Carbon plugins are NOT registered with Facepunch's
                // HarmonyLoader (Carbon has its own harmony infrastructure).
                // We are already invisible in that report — skip the patch
                // to avoid touching an API that has no relevance to us.
                if (!IsCarbon)
                {
                    try
                    {
                        Type harmonyLoaderType = null;
                        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                        {
                            try { harmonyLoaderType ??= asm.GetType("HarmonyLoader"); if (harmonyLoaderType != null) break; }
                            catch { }
                        }
                        if (harmonyLoaderType != null)
                        {
                            var getMods = harmonyLoaderType.GetMethod("GetHarmonyMods",
                                BindingFlags.Public | BindingFlags.Static);
                            if (getMods != null)
                            {
                                var postfix = typeof(AdminLogger).GetMethod(nameof(GetHarmonyModsPostfix),
                                    BindingFlags.NonPublic | BindingFlags.Static);
                                if (postfix != null)
                                {
                                    _harmony.Patch(getMods, postfix: new HarmonyMethod(postfix));
                                    Log("Harmony: patched HarmonyLoader.GetHarmonyMods (hide self)");
                                }
                            }
                        }
                    }
                    catch (Exception ex) { PrintWarning($"Patch HarmonyLoader.GetHarmonyMods: {ex.Message}"); }
                }
                else
                {
                    Log("Carbon detected: skipping HarmonyLoader.GetHarmonyMods patch (Carbon plugins are not in that list)");
                }

                // 4c-8. FP server-event dump. Postfix the three vanilla
                // Facepunch.Rust.Analytics.Azure emitters that build + Submit()
                // an EventRecord for the server-side events we care about:
                //   OnSteamAuth        → "steam_auth"
                //   OnPlayerConnected  → "player_connect"
                //   OnPlayerDisconnected → "player_disconnect"
                // None of these has the `if (!GameplayAnalytics) return;` guard,
                // so they fire on every server regardless of the convar. We read
                // the same fields the original AddField'd and dump them with a
                // ms-precise UTC timestamp (see DumpFacepunchServerEvent). The
                // Azure class is nested → reflect "Facepunch.Rust.Analytics+Azure".
                if (_config?.DumpFacepunchServerEvents != false)
                {
                    try
                    {
                        Type azureType = null;
                        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                        {
                            try { azureType ??= asm.GetType("Facepunch.Rust.Analytics+Azure"); if (azureType != null) break; }
                            catch { }
                        }
                        if (azureType != null)
                        {
                            PatchAnalyticsDump(azureType, "OnPlayerConnected",
                                nameof(OnPlayerConnectedDumpPostfix), new[] { typeof(Connection) });
                            PatchAnalyticsDump(azureType, "OnPlayerDisconnected",
                                nameof(OnPlayerDisconnectedDumpPostfix), new[] { typeof(Connection), typeof(string) });
                            PatchAnalyticsDump(azureType, "OnSteamAuth",
                                nameof(OnSteamAuthDumpPostfix), new[] { typeof(ulong), typeof(ulong), typeof(string) });
                        }
                        else PrintWarning("Facepunch.Rust.Analytics+Azure type not found — FP event dump disabled");
                    }
                    catch (Exception ex) { PrintWarning($"Patch Analytics.Azure dump: {ex.Message}"); }
                }

                // 4c-2. Prefix on ArgEx.GetPlayerOrSleeperOrBot. The vanilla
                // method uses `TryGetUInt` which fails for real 64-bit Steam
                // IDs (76561199... overflows uint), so it can't resolve our
                // bot by id. We intercept the call, try parsing arg as ulong,
                // and return our bot from _bots if matched. Used by `teleport`
                // / `teleport2me` and every other admin command that resolves
                // a target id.
                try
                {
                    // ArgEx lives in the UnityEngine namespace (source: UnityEngine/ArgEx.cs).
                    var argExType = Type.GetType("UnityEngine.ArgEx, Assembly-CSharp");
                    if (argExType == null)
                    {
                        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                        {
                            try
                            {
                                argExType ??= asm.GetType("UnityEngine.ArgEx") ?? asm.GetType("ArgEx");
                                if (argExType != null) break;
                            }
                            catch { }
                        }
                    }
                    if (argExType != null)
                    {
                        var gposb = argExType.GetMethod("GetPlayerOrSleeperOrBot",
                            BindingFlags.Public | BindingFlags.Static,
                            null, new[] { typeof(ConsoleSystem.Arg), typeof(int) }, null);
                        if (gposb != null)
                        {
                            var prefix = typeof(AdminLogger).GetMethod(nameof(GetPlayerOrSleeperOrBotPrefix),
                                BindingFlags.NonPublic | BindingFlags.Static);
                            if (prefix != null)
                                _harmony.Patch(gposb, prefix: new HarmonyMethod(prefix));
                            Log("Harmony: patched ArgEx.GetPlayerOrSleeperOrBot (prefix)");
                        }
                        else PrintWarning("ArgEx.GetPlayerOrSleeperOrBot not found");
                    }
                    else PrintWarning("ArgEx type not found");
                }
                catch (Exception ex) { PrintWarning($"Patch ArgEx.GetPlayerOrSleeperOrBot: {ex.Message}"); }

                // 5. Patch ConVar.Admin.status — replace output for bots (no Connection → "NO CONNECTION")
                var statusMethod = typeof(ConVar.Admin).GetMethod("status",
                    BindingFlags.Public | BindingFlags.Static);
                if (statusMethod != null)
                {
                    var stPrefix = typeof(AdminLogger).GetMethod(nameof(StatusPrefix),
                        BindingFlags.NonPublic | BindingFlags.Static);
                    _harmony.Patch(statusMethod, prefix: new HarmonyMethod(stPrefix));
                    Log("Harmony: patched ConVar.Admin.status");
                }

                // 5b. Patch ConVar.Admin.stats — sleeper bots are permanently in
                // activePlayerList so vanilla already renders their row, but the
                // `time` column reads ServerStatistics.Get(id).Get("time"), which
                // stays 0 for bots (the vanilla playtime accumulator never runs
                // for our connection-less bots → "00:00:00"). The prefix seeds
                // each bot's storage with its current connected seconds so the
                // table shows a real HH:MM:SS. Prefix-only — no list injection.
                var statsCmd = typeof(ConVar.Admin).GetMethod("stats",
                    BindingFlags.Public | BindingFlags.Static);
                if (statsCmd != null)
                {
                    var statsPrefix = typeof(AdminLogger).GetMethod(nameof(StatsTimePrefix),
                        BindingFlags.NonPublic | BindingFlags.Static);
                    _harmony.Patch(statsCmd, prefix: new HarmonyMethod(statsPrefix));
                    Log("Harmony: patched ConVar.Admin.stats (populate bot time)");
                }

                // 6. Patch ConVar.Admin.playerlist — AdminUI data source, crashes on null connection
                var playerlistMethod = typeof(ConVar.Admin).GetMethod("playerlist",
                    BindingFlags.Public | BindingFlags.Static);
                if (playerlistMethod != null)
                {
                    var plPrefix = typeof(AdminLogger).GetMethod(nameof(PlayerListPrefix),
                        BindingFlags.NonPublic | BindingFlags.Static);
                    _harmony.Patch(playerlistMethod, prefix: new HarmonyMethod(plPrefix));
                    Log("Harmony: patched ConVar.Admin.playerlist");
                }

                // 8. Patch ServerMgr.OnValidateAuthTicketResponse — when Steam validates bot ticket,
                // the vanilla method prints "unconnected id" warning (bot is not in Net.sv.connections).
                // We catch it, call UpdatePlayer in the callback context so Steam finalizes the bot's
                // registration in the A2S_PLAYER list, and skip the warning.
                var onValidateMethod = typeof(ServerMgr).GetMethod("OnValidateAuthTicketResponse",
                    BindingFlags.NonPublic | BindingFlags.Instance);
                if (onValidateMethod != null)
                {
                    var vaPrefix = typeof(AdminLogger).GetMethod(nameof(ValidateAuthTicketPrefix),
                        BindingFlags.NonPublic | BindingFlags.Static);
                    _harmony.Patch(onValidateMethod, prefix: new HarmonyMethod(vaPrefix));
                    Log("Harmony: patched ServerMgr.OnValidateAuthTicketResponse");
                }

                // 7. Patch ConVar.Admin.playerlistids — same fix
                var playerlistidsMethod = typeof(ConVar.Admin).GetMethod("playerlistids",
                    BindingFlags.Public | BindingFlags.Static);
                if (playerlistidsMethod != null)
                {
                    var plidPrefix = typeof(AdminLogger).GetMethod(nameof(PlayerListIdsPrefix),
                        BindingFlags.NonPublic | BindingFlags.Static);
                    _harmony.Patch(playerlistidsMethod, prefix: new HarmonyMethod(plidPrefix));
                    Log("Harmony: patched ConVar.Admin.playerlistids");
                }

                // 8. Patch vanilla `players` / `users` / `usersinrange` / `usersinrangeofplayer`
                // so bots show up in their output. The command methods live on
                // different ConVar types across Rust versions — ConVar.Admin is
                // the usual home, but `players` can be declared on ConVar.Global
                // or ConVar.Server depending on build. Walk candidates in order
                // and patch the first match.
                // Resolve sibling ConVar classes via the same assembly where
                // ConVar.Admin lives (Assembly-CSharp). `Type.GetType("ConVar.Global")`
                // returns null unless the AQN matches exactly, which differs
                // across Rust builds — using the sibling's Assembly is robust.
                var convarAsm = typeof(ConVar.Admin).Assembly;
                var convarTypes = new[]
                {
                    typeof(ConVar.Admin),
                    convarAsm.GetType("ConVar.Global"),
                    convarAsm.GetType("ConVar.Server"),
                };
                PrintWarning($"ConVar resolution: Admin={typeof(ConVar.Admin) != null}, Global={convarTypes[1] != null}, Server={convarTypes[2] != null}");
                foreach (var (name, prefixName) in new[] {
                    ("players", nameof(PlayersPrefix)),
                    ("users", nameof(UsersPrefix)),
                    ("usersinrange", nameof(UsersInRangePrefix)),
                    ("usersinrangeofplayer", nameof(UsersInRangeOfPlayerPrefix)),
                })
                {
                    var pref = typeof(AdminLogger).GetMethod(prefixName,
                        BindingFlags.NonPublic | BindingFlags.Static);
                    if (pref == null) continue;

                    // Rust declares some commands (notably `players`) on BOTH
                    // ConVar.Admin AND ConVar.Global — one is registered as
                    // `admin.players`, the other as `global.players`, and an
                    // unqualified `players` console command resolves to the
                    // Global variant. Patching only the first match let the
                    // Global variant run vanilla and print "No players are
                    // currently online" even when bots were in activePlayerList.
                    // Patch every match.
                    int patched = 0;
                    foreach (var t in convarTypes)
                    {
                        if (t == null) continue;
                        var m = t.GetMethod(name, BindingFlags.Public | BindingFlags.Static);
                        if (m == null) continue;
                        try
                        {
                            _harmony.Patch(m, prefix: new HarmonyMethod(pref));
                            PrintWarning($"Harmony: patched {t.FullName}.{name}");
                            patched++;
                        }
                        catch (Exception ex) { PrintWarning($"Patch {t.FullName}.{name}: {ex.Message}"); }
                    }
                    if (patched == 0)
                        PrintWarning($"ConVar.*.{name}: not found on any known type (Admin/Global/Server) — command will keep vanilla behaviour");
                }
            }
            catch (Exception ex)
            {
                PrintWarning($"Harmony patch failed: {ex}");
            }
        }

        private static bool PingPrefix(Connection connection, ref int __result)
        {
            // Bots have no connection → native GetAveragePing would NullRef.
            // Return a stable fake ping (per-bot base + small jitter).
            if (connection == null)
            {
                __result = UnityEngine.Random.Range(40, 91);
                return false;
            }

            if (_instance != null && _instance._bots.TryGetValue(connection.userid, out var bi))
            {
                __result = GetBotDisplayPing(bi);
                return false;
            }
            return true; // run original for real players
        }

        // Guard BasePlayer.RemoveFromPlayerCache (private static) against
        // double-removal. Returns false (skip original) when the player is
        // already absent from the cache (ActivePlayerInd == -1), making the
        // call a safe no-op. Without this, a second removal passes -1 to
        // GetIndexForSyncRemove → bad array index → IndexOutOfRangeException
        // logged as "Server Exception: Player Update".
        private static bool RemoveFromPlayerCachePrefix(BasePlayer player)
        {
            if (player == null) return false;
            try { return player.ActivePlayerInd != -1; }
            catch { return false; }
        }

        // Skip BasePlayer.ServerUpdate*/PlayerUpdate*/ConnectedPlayerUpdate
        // for two cases:
        //   1. The player is one of our bots (entry in _bots).
        //   2. BasePlayer.net is null — a short window during a fresh join /
        //      respawn where Rust adds the player to the active list before
        //      its Connection is fully wired up. Per-tick code paths NRE on
        //      net.connection / net.user during this window for ALL players,
        //      not just bots. Skipping the tick here is safe — the original
        //      can't do anything useful without net anyway, and the next
        //      tick (after wiring) runs as normal.
        // Any reflection/access exception → skip too: throwing from the
        // tick is exactly what we're trying to prevent.
        // NOTE: ServerUpdate/PlayerUpdate/ConnectedPlayerUpdate do not exist
        // in Rust v2624+; the per-player tick runs via ConnectedPlayersUpdate
        // (ReadOnlySpan<BasePlayer>) in the job system — Harmony cannot patch
        // that signature. The RemoveFromPlayerCachePrefix above is the actual
        // fix for the crash in current builds.
        private static bool ServerUpdatePrefix(BasePlayer __instance)
        {
            if (__instance == null || _instance == null) return true;
            try
            {
                if (__instance.net == null) return false;
                ulong id = __instance.userID;
                if (_instance._bots.ContainsKey(id)) return false;
            }
            catch { return false; }
            return true;
        }

        // For methods where BasePlayer is passed as the first parameter (rather
        // than __instance) — e.g. PlayerUpdateJobs.Run(BasePlayer p, ...) on
        // newer Rust builds. Harmony binds the parameter by name "__0" → we
        // request it explicitly via the parameter name in the patched signature.
        private static bool BotByFirstParamPrefix(BasePlayer __0)
        {
            if (__0 == null || _instance == null) return true;
            try
            {
                if (__0.net == null) return false;
                ulong id = __0.userID;
                if (_instance._bots.ContainsKey(id)) return false;
            }
            catch { return false; }
            return true;
        }

        // Postfix on HarmonyLoader.GetHarmonyMods() — filters out any entry
        // whose AssemblyName contains our Harmony id. Rust submits the
        // resulting list to FP analytics; after this patch we become
        // invisible in that report. Other plugins remain visible.
        private static readonly string[] _hideHarmonyNames = new[]
        {
            "com.1ak1.adminlogger",
            "adminlogger",
            "adminpanel",
        };
        private static FieldInfo _hmiNameField;
        private static PropertyInfo _hmiNameProp;
        private static void GetHarmonyModsPostfix(ref System.Collections.IEnumerable __result)
        {
            if (__result == null) return;
            try
            {
                var filtered = new System.Collections.Generic.List<object>();
                foreach (var item in __result)
                {
                    if (item == null) continue;
                    string name = null;
                    try
                    {
                        if (_hmiNameField == null && _hmiNameProp == null)
                        {
                            var t = item.GetType();
                            _hmiNameField = t.GetField("AssemblyName", BindingFlags.Public | BindingFlags.Instance)
                                          ?? t.GetField("Name", BindingFlags.Public | BindingFlags.Instance);
                            _hmiNameProp = t.GetProperty("AssemblyName", BindingFlags.Public | BindingFlags.Instance)
                                         ?? t.GetProperty("Name", BindingFlags.Public | BindingFlags.Instance);
                        }
                        if (_hmiNameField != null) name = _hmiNameField.GetValue(item) as string;
                        else if (_hmiNameProp != null) name = _hmiNameProp.GetValue(item) as string;
                    }
                    catch { }

                    bool hide = false;
                    if (!string.IsNullOrEmpty(name))
                    {
                        var lower = name.ToLowerInvariant();
                        foreach (var h in _hideHarmonyNames)
                        {
                            if (lower.Contains(h)) { hide = true; break; }
                        }
                    }
                    if (!hide) filtered.Add(item);
                }
                __result = filtered;
            }
            catch { }
        }

        // Hot-load: third-party plugins may be compiled & loaded after AdminLogger.
        // Oxide fires OnPluginLoaded for every plugin once it's ready —
        // re-run the bot-crash patcher (it short-circuits if already done).
        void OnPluginLoaded(Plugin plugin)
        {
            if (plugin == null) return;
            TryPatchThirdPartyBotCrash(plugin);
        }

        // Third-party plugins that look up player.userID in their own
        // dictionaries on OnPlayerConnected/OnPlayerDisconnected — they crash
        // with KeyNotFoundException for our synthetic bots because the bot
        // never went through their normal registration flow (Steam auth,
        // permission load, etc.). We Harmony-prefix their hook methods to
        // skip the body when the player is one of our bots.
        //
        // Add plugin names here as we discover crashes. The patch is applied
        // by *plugin name* and *method signature* — if the plugin doesn't
        // declare the method the patch is silently skipped.
        private static readonly string[] _skipForBotsPlugins = new[]
        {
            "IQChat",
        };

        // Track patched plugin types so we don't double-patch on reload.
        private static readonly HashSet<string> _patchedThirdPartyTypes = new HashSet<string>();

        private void TryPatchThirdPartyBotCrash(Plugin plugin)
        {
            try
            {
                bool match = false;
                foreach (var n in _skipForBotsPlugins)
                {
                    if (plugin.Name == n) { match = true; break; }
                }
                if (!match) return;

                var t = plugin.GetType();
                var key = t.AssemblyQualifiedName ?? t.FullName;
                if (_patchedThirdPartyTypes.Contains(key)) return;
                _patchedThirdPartyTypes.Add(key);

                if (_harmony == null)
                {
                    PrintWarning($"TryPatchThirdPartyBotCrash({plugin.Name}): _harmony is null, skipping");
                    return;
                }

                var prefix = typeof(AdminLogger).GetMethod(nameof(SkipForBotsPrefix),
                    BindingFlags.NonPublic | BindingFlags.Static);

                var conn = t.GetMethod("OnPlayerConnected",
                    BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance,
                    null, new[] { typeof(BasePlayer) }, null);
                if (conn != null)
                {
                    _harmony.Patch(conn, prefix: new HarmonyMethod(prefix));
                    Log($"Harmony: patched {plugin.Name}.OnPlayerConnected (skip for bots)");
                }

                var disc = t.GetMethod("OnPlayerDisconnected",
                    BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance,
                    null, new[] { typeof(BasePlayer), typeof(string) }, null);
                if (disc != null)
                {
                    _harmony.Patch(disc, prefix: new HarmonyMethod(prefix));
                    Log($"Harmony: patched {plugin.Name}.OnPlayerDisconnected (skip for bots)");
                }
            }
            catch (Exception ex)
            {
                PrintWarning($"TryPatchThirdPartyBotCrash({plugin?.Name}): {ex.Message}");
            }
        }

        // Prefix for third-party plugin hooks — first parameter is BasePlayer.
        // Returns false (skip original) when the player is our bot.
        private static bool SkipForBotsPrefix(BasePlayer player)
        {
            if (player == null || _instance == null) return true;
            try { return !_instance._bots.ContainsKey(player.userID); }
            catch { return true; }
        }

        // Prefix on ArgEx.GetPlayerOrSleeperOrBot. Vanilla's `TryGetUInt`
        // overflows on real 64-bit Steam IDs. We parse the arg as ulong
        // first, lookup in our _bots dict, and return our bot if matched.
        // Otherwise pass through to the original.
        private static bool GetPlayerOrSleeperOrBotPrefix(ConsoleSystem.Arg arg, int iArgNum, ref BasePlayer __result)
        {
            if (_instance == null) return true;
            try
            {
                string raw = arg.GetString(iArgNum);
                if (!string.IsNullOrEmpty(raw))
                {
                    if (ulong.TryParse(raw, out ulong id) && id != 0)
                    {
                        if (_instance._bots.TryGetValue(id, out var bi)
                            && bi?.Player != null && !bi.Player.IsDestroyed)
                        {
                            __result = bi.Player;
                            return false; // skip original
                        }
                    }
                    // Fallback: match by displayName (case-insensitive, exact first, then contains)
                    foreach (var kvp in _instance._bots)
                    {
                        var bi = kvp.Value;
                        if (bi?.Player == null || bi.Player.IsDestroyed) continue;
                        if (string.Equals(bi.DisplayName, raw, System.StringComparison.OrdinalIgnoreCase))
                        {
                            __result = bi.Player;
                            return false;
                        }
                    }
                    foreach (var kvp in _instance._bots)
                    {
                        var bi = kvp.Value;
                        if (bi?.Player == null || bi.Player.IsDestroyed) continue;
                        if (!string.IsNullOrEmpty(bi.DisplayName)
                            && bi.DisplayName.IndexOf(raw, System.StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            __result = bi.Player;
                            return false;
                        }
                    }
                }
            }
            catch { }
            return true; // run original
        }

        // Full replacement of ConVar.Admin.status so bots show proper rows instead of "NO CONNECTION".
        // Mirrors the vanilla method layout but substitutes bot data from BotInfo.
        private static bool StatusPrefix(ConsoleSystem.Arg arg)
        {
            if (_instance == null) return true;
            try
            {
                string filter = arg.GetString(0);
                if (filter == "--json") filter = arg.GetString(1);
                bool json = arg.HasArg("--json");

                int totalPlayers = BasePlayer.activePlayerList.Count;
                string header = string.Empty;
                if (!json && filter.Length == 0)
                {
                    header += "hostname: " + ConVar.Server.hostname + "\n";
                    header += "version : " + GetServerProtocolVersion() + " secure (secure mode enabled, connected to Steam3)\n";
                    header += "map     : " + ConVar.Server.level + "\n";
                    header += $"players : {totalPlayers} ({ConVar.Server.maxplayers} max) ({SingletonComponent<ServerMgr>.Instance.connectionQueue.Queued} queued) ({SingletonComponent<ServerMgr>.Instance.connectionQueue.Joining} joining)\n\n";
                }

                using (var table = Facepunch.Pool.Get<TextTable>())
                {
                    table.ShouldPadColumns = !json;
                    table.AddColumn("id");
                    table.AddColumn("name");
                    table.AddColumn("ping");
                    table.AddColumn("connected");
                    table.AddColumn("addr");
                    table.AddColumn("owner");
                    table.AddColumn("violation");
                    table.AddColumn("kicks");
                    table.AddColumn("entityId");

                    foreach (var p in BasePlayer.activePlayerList)
                    {
                        try
                        {
                            if (p == null || !p.IsValid()) continue;

                            string id = p.UserIDString;
                            BotInfo botInfo;
                            bool isBot = _instance._bots.TryGetValue(p.userID, out botInfo);

                            string name, ping, connected, addr, owner, entityId;
                            if (isBot)
                            {
                                name = (botInfo.DisplayName ?? p.displayName ?? "").QuoteSafe();
                                ping = GetBotDisplayPing(botInfo).ToString();
                                // Vanilla prints connection.GetSecondsConnected() + "s" — a raw
                                // float, i.e. 7 significant figures. At a short 62s session that
                                // renders 5 decimals ("61.93249s"), which makes the bot row stand
                                // out next to long-connected players whose floats trim to 3
                                // decimals ("6411.214s"). Pin to 3 decimals so every row reads
                                // uniformly ("61.932s" / "6411.214s").
                                float secs = (float)(TimeEx.realtimeSinceStartup - botInfo.OriginalConnectionTime);
                                if (secs < 0f) secs = 0f;
                                connected = secs.ToString("0.000") + "s";
                                addr = botInfo.IpAddress ?? "0.0.0.0";
                                owner = id;
                                entityId = (p.net != null ? p.net.ID.Value.ToString() : "0");
                            }
                            else
                            {
                                var conn = p.net?.connection;
                                if (conn == null)
                                {
                                    table.AddRow(id, "NO CONNECTION");
                                    continue;
                                }
                                owner = conn.ownerid.ToString();
                                name = p.displayName.QuoteSafe();
                                ping = Network.Net.sv.GetAveragePing(conn).ToString();
                                addr = conn.ipaddress;
                                entityId = p.net.ID.Value.ToString();
                                connected = conn.GetSecondsConnected() + "s";
                            }


                        }
                        catch (Exception ex)
                        {
                            try { table.AddRow(p.UserIDString, ex.Message.QuoteSafe()); } catch { }
                        }
                    }

                    if (json) arg.ReplyWith(table.ToJson());
                    else arg.ReplyWith(header + table.ToString());
                }
                return false; // skip original
            }
            catch (Exception ex)
            {
                _instance.PrintWarning($"StatusPrefix failed: {ex.Message}, falling back to vanilla");
                return true; // run original as fallback
            }
        }

        // Prefix on ConVar.Admin.stats — seed each bot's ServerStatistics "time"
        // with its current connected seconds so the stats table shows a real
        // HH:MM:SS instead of 00:00:00. Vanilla renders the row already (bots are
        // in activePlayerList) but reads Storage.Get("time"), which is never
        // populated for our connection-less bots. Storage exposes no setter, so
        // we Add the delta to reach the target value (idempotent across calls).
        private static void StatsTimePrefix()
        {
            if (_instance == null) return;
            try
            {
                foreach (var kvp in _instance._bots)
                {
                    var bi = kvp.Value;
                    if (bi == null || bi.Player == null || bi.Player.IsDestroyed) continue;

                    int connectedSeconds = (int)(TimeEx.realtimeSinceStartup - bi.OriginalConnectionTime);
                    if (connectedSeconds < 0) connectedSeconds = 0;

                    var storage = ServerStatistics.Get(kvp.Key);
                    if (storage == null) continue;

                    int current = storage.Get("time");
                    if (connectedSeconds != current)
                        storage.Add("time", connectedSeconds - current);
                }
            }
            catch (Exception ex) { _instance?.PrintWarning($"StatsTimePrefix: {ex.Message}"); }
        }

        // Prefix for ServerMgr.OnValidateAuthTicketResponse — if Steam validated a bot's ticket,
        // register the bot as "connected" from Steam's POV by calling UpdatePlayer in the callback context.
        // Skips the vanilla "unconnected id" warning.
        private static bool ValidateAuthTicketPrefix(ulong SteamId, ulong OwnerId, AuthResponse Status)
        {
            if (_instance == null) return true;
            // Steam supplies only SteamId, not the ticket/attempt ID. This is
            // an association with the current local trace, never proof that a
            // delayed callback belongs to that attempt. Record even after removal.
            if (_instance._authTraces.ContainsKey(SteamId))
                _instance.AuthAudit(SteamId, "validate_callback", response: Status.ToString());
            if (!_instance._bots.TryGetValue(SteamId, out var botInfo)) return true; // not our bot

            double beganAt;
            string authDelta = _instance._steamAuthBeginAt.TryGetValue(SteamId, out beganAt)
                ? $"{(TimeEx.realtimeSinceStartup - beganAt):F2}s after BeginAuthSession"
                : "NO BeginAuthSession timestamp (noauth/zombie?)";
            _instance.Log($"[STEAMAUTH] OnValidateAuthTicketResponse {SteamId} owner={OwnerId} status={Status} | {authDelta}");

            if (Status == AuthResponse.OK)
            {
                _instance._steamAuthRespOk++;
                _instance._steamAuthBeginAt.Remove(SteamId);
                // Respect ConVar.Server.censorplayerlist — same logic as Auth_Steam.cs:61.
                // If censor is on, real players get RandomUsernames; bots should follow the same rule
                // so A2S_PLAYER is consistent across real/fake players.
                string publicName = botInfo.DisplayName;
                try
                {
                    if (ConVar.Server.censorplayerlist)
                        publicName = RandomUsernames.Get(SteamId + (ulong)UnityEngine.Random.Range(0, 100000));
                }
                catch (Exception ex)
                {
                    _instance.PrintWarning($"censorplayerlist handling failed: {ex.Message}");
                }

                // Call UpdatePlayer RIGHT HERE — in the callback context — so Steam registers the name.
                try
                {
                    SteamServer.UpdatePlayer(SteamId, publicName, 0);
                    _instance.Log($"SteamServer.UpdatePlayer (callback): {SteamId} -> '{publicName}' (censor={ConVar.Server.censorplayerlist})");
                }
                catch (Exception ex)
                {
                    _instance.PrintWarning($"UpdatePlayer in callback failed: {ex.Message}");
                }

                // Also try PlatformService path (defense in depth).
                _instance.TryUpdatePlatformPlayerSession(SteamId, publicName);

                botInfo.HasSteamSession = true;

                // player_connect ПОСЛЕ steam_auth — как у реального игрока. Этот колбэк
                // вызывается из RustPlatformHooks.AuthSessionValidated сразу за
                // Analytics.OnSteamAuth (та же строка хука), поэтому порядок событий на
                // проводе совпадает с ванилью (steam_auth → player_connect). ip берём из
                // botInfo.IpAddress (уже с :port). noauth-ререгистр сюда не доходит
                // (BeginAuthSession не звался) — дубля player_connect не будет.
                try { _instance.EmitPlayerConnectAnalytics(SteamId, botInfo.DisplayName, botInfo.IpAddress); } catch { }

                // Сообщаем контроллеру что Steam подтвердил тикет — он держит
                // парный с steam_auth_lost флаг для UI колонки «Steam».
                try { _instance.SendEvent(SteamId, "steam_auth_ok", ""); } catch { }

                _instance.Log($"[STEAMAUTH] === STATS begun={_instance._steamAuthBegun} respOk={_instance._steamAuthRespOk} respFail={_instance._steamAuthRespFail} pending={_instance._steamAuthBeginAt.Count} (begun-ok-fail={_instance._steamAuthBegun - _instance._steamAuthRespOk - _instance._steamAuthRespFail}) ===");
            }
            else
            {
                _instance._steamAuthRespFail++;
                _instance._steamAuthBeginAt.Remove(SteamId);
                _instance.PrintWarning($"[STEAMAUTH] Bot {SteamId} Steam ticket response NOT OK: {Status} | begun={_instance._steamAuthBegun} respOk={_instance._steamAuthRespOk} respFail={_instance._steamAuthRespFail}");
                botInfo.HasSteamSession = false;

                // Notify the controller so it can issue a fresh ticket via cmd refresh_ticket.
                // Non-recoverable statuses (banned/vac) are still emitted — controller applies
                // its own backoff / circuit breaker.
                try { _instance.SendEvent(SteamId, "steam_auth_lost", Status.ToString()); } catch { }
            }

            return false; // skip original (no warning, no further processing)
        }

        // Replacement for ConVar.Admin.playerlist — used by AdminUI_RequestPlayerList / AdminUI_FullRefresh.
        // Vanilla dereferences x.net.connection.* for every active player → crashes on bots.
        private static bool PlayerListPrefix(ConsoleSystem.Arg arg, ref ConVar.Admin.PlayerInfo[] __result)
        {
            if (_instance == null) return true;
            var list = new List<ConVar.Admin.PlayerInfo>(BasePlayer.activePlayerList.Count);
            try
            {
                bool showAddress = arg.Connection == null || arg.Connection.authLevel >= 2;
                foreach (var p in BasePlayer.activePlayerList)
                {
                    // Per-entry guard: a bot mid-unbind is Kill()'d before it is
                    // pulled from activePlayerList, so for one frame it can be
                    // listed while its transform/net are being torn down. Skip
                    // such an entry instead of aborting the whole list.
                    try
                    {
                        if (p == null || !p.IsValid()) continue;
                        BotInfo botInfo;
                        bool isBot = _instance._bots.TryGetValue(p.userID, out botInfo);
                        var conn = p.net?.connection;

                        int ping;
                        string address;
                        int connectedSeconds;
                        ulong entityId = (p.net != null ? p.net.ID.Value : 0UL);

                        if (isBot || conn == null)
                        {
                            ping = GetBotDisplayPing(botInfo);
                            address = (showAddress && isBot) ? (botInfo.IpAddress ?? string.Empty) : string.Empty;
                            connectedSeconds = isBot
                                ? (int)(TimeEx.realtimeSinceStartup - botInfo.OriginalConnectionTime)
                                : 0;
                        }
                        else
                        {
                            ping = Network.Net.sv.GetAveragePing(conn);
                            address = showAddress ? conn.ipaddress : string.Empty;
                            connectedSeconds = (int)conn.GetSecondsConnected();
                        }

                        list.Add(new ConVar.Admin.PlayerInfo
                        {
                            SteamID = p.UserIDString,
                            OwnerSteamID = p.OwnerID.ToString(),
                            DisplayName = p.displayName,
                            Ping = ping,
                            Address = address,
                            EntityId = entityId,
                            ConnectedSeconds = connectedSeconds,
                            Health = p.Health(),
                            Position = (p.transform != null) ? p.transform.position : Vector3.zero,
                            IsMuted = p.HasPlayerFlag(BasePlayer.PlayerFlags.ChatMute),
                            TeamID = p.currentTeam
                        });
                    }
                    catch (Exception exItem)
                    {
                        _instance.Log($"PlayerListPrefix: skipped a player mid-teardown: {exItem.Message}");
                    }
                }
            }
            catch (Exception ex)
            {
                _instance.PrintWarning($"PlayerListPrefix failed: {ex.Message}");
                // Deliberately DO NOT return true here. Vanilla playerlist
                // dereferences x.net.connection.* unconditionally and NREs on
                // any bot (null connection) — falling through to it is exactly
                // the "global.playerlist - Object reference not set" crash we
                // are preventing. Return whatever we built instead.
            }
            __result = list.ToArray();
            return false;
        }

        // Replacement for ConVar.Admin.playerlistids — same null-conn crash on bots.
        private static bool PlayerListIdsPrefix(ConsoleSystem.Arg arg, ref ConVar.Admin.PlayerIDInfo[] __result)
        {
            if (_instance == null) return true;
            var list = new List<ConVar.Admin.PlayerIDInfo>(BasePlayer.activePlayerList.Count);
            try
            {
                bool showAddress = arg.Connection == null || arg.Connection.authLevel >= 2;
                foreach (var p in BasePlayer.activePlayerList)
                {
                    try
                    {
                        if (p == null || !p.IsValid()) continue;
                        BotInfo botInfo;
                        bool isBot = _instance._bots.TryGetValue(p.userID, out botInfo);
                        var conn = p.net?.connection;

                        string address;
                        if (isBot || conn == null)
                            address = (showAddress && isBot) ? (botInfo.IpAddress ?? string.Empty) : string.Empty;
                        else
                            address = showAddress ? conn.ipaddress : string.Empty;

                        list.Add(new ConVar.Admin.PlayerIDInfo
                        {
                            SteamID = p.UserIDString,
                            OwnerSteamID = p.OwnerID.ToString(),
                            DisplayName = p.displayName,
                            Address = address,
                            EntityId = (p.net != null ? p.net.ID.Value : 0UL)
                        });
                    }
                    catch (Exception exItem)
                    {
                        _instance.Log($"PlayerListIdsPrefix: skipped a player mid-teardown: {exItem.Message}");
                    }
                }
            }
            catch (Exception ex)
            {
                _instance.PrintWarning($"PlayerListIdsPrefix failed: {ex.Message}");
                // Never fall through to vanilla playerlistids — see PlayerListPrefix.
            }
            __result = list.ToArray();
            return false;
        }

        // Vanilla `users` command format (from source): `<slot:userid:"name">\nID:"name"\n...\nN users\n`
        private static bool UsersPrefix(ConsoleSystem.Arg arg)
        {
            if (_instance == null) return true;
            try
            {
                string text = "<slot:userid:\"name\">\n";
                int num = 0;
                foreach (var p in BasePlayer.activePlayerList)
                {
                    if (p == null || !p.IsValid()) continue;
                    text = text + p.userID.Get() + ":\"" + p.displayName + "\"\n";
                    num++;
                }
                text = text + num + "users\n";
                arg.ReplyWith(text);
                return false;
            }
            catch (Exception ex)
            {
                _instance.PrintWarning($"UsersPrefix failed: {ex.Message}");
                return true;
            }
        }

        // `usersinrange <pos> <radius>` — list players (incl. bots) whose position is in range.
        private static bool UsersInRangePrefix(ConsoleSystem.Arg arg)
        {
            if (_instance == null) return true;
            try
            {
                Vector3 center = arg.GetVector3(0, Vector3.zero);
                float radius = arg.GetFloat(1, 0f);
                if (radius <= 0f) return true;
                float rsq = radius * radius;
                var sb = Facepunch.Pool.Get<System.Text.StringBuilder>();
                sb.Clear();
                int count = 0;
                foreach (var p in BasePlayer.activePlayerList)
                {
                    if (p == null || !p.IsValid()) continue;
                    float d = (p.transform.position - center).sqrMagnitude;
                    if (d > rsq) continue;
                    sb.Append(p.UserIDString).Append(" \"").Append(p.displayName).Append("\" ").AppendFormat("{0:F1}", Mathf.Sqrt(d)).Append("m\n");
                    count++;
                }
                sb.Insert(0, $"<{count} users in range of {center}>\n");
                arg.ReplyWith(sb.ToString());
                Facepunch.Pool.FreeUnmanaged(ref sb);
                return false;
            }
            catch (Exception ex)
            {
                _instance.PrintWarning($"UsersInRangePrefix failed: {ex.Message}");
                return true;
            }
        }

        // `usersinrangeofplayer <id> <radius>` — list players (incl. bots) near target player.
        private static bool UsersInRangeOfPlayerPrefix(ConsoleSystem.Arg arg)
        {
            if (_instance == null) return true;
            try
            {
                ulong targetId = arg.GetUInt64(0, 0UL);
                float radius = arg.GetFloat(1, 0f);
                if (targetId == 0 || radius <= 0f) return true;

                // Find target — check both activePlayerList and our bots
                BasePlayer target = null;
                foreach (var p in BasePlayer.activePlayerList)
                    if (p != null && p.userID == targetId) { target = p; break; }
                if (target == null && _instance._bots.TryGetValue(targetId, out var tBot))
                    target = tBot.Player;
                if (target == null) return true;

                Vector3 center = target.transform.position;
                float rsq = radius * radius;
                var sb = Facepunch.Pool.Get<System.Text.StringBuilder>();
                sb.Clear();
                int count = 0;
                foreach (var p in BasePlayer.activePlayerList)
                {
                    if (p == null || !p.IsValid() || p == target) continue;
                    float d = (p.transform.position - center).sqrMagnitude;
                    if (d > rsq) continue;
                    sb.Append(p.UserIDString).Append(" \"").Append(p.displayName).Append("\" ").AppendFormat("{0:F1}", Mathf.Sqrt(d)).Append("m\n");
                    count++;
                }
                sb.Insert(0, $"<{count} users in range of {target.displayName}>\n");
                arg.ReplyWith(sb.ToString());
                Facepunch.Pool.FreeUnmanaged(ref sb);
                return false;
            }
            catch (Exception ex)
            {
                _instance.PrintWarning($"UsersInRangeOfPlayerPrefix failed: {ex.Message}");
                return true;
            }
        }

        // Full replacement of ConVar.Admin.players — vanilla method reads
        // `activePlayer.net.connection` directly (no null check) which crashed
        // on sleeper-bots previously. Synthesize unified table.
        private static bool PlayersPrefix(ConsoleSystem.Arg arg)
        {
            if (_instance == null) return true;
            try
            {
                bool json = arg.HasArg("--json");
                using (var table = Facepunch.Pool.Get<TextTable>())
                {
                    table.ShouldPadColumns = !json;
                    table.AddColumn("id");
                    table.AddColumn("name");
                    table.AddColumn("ping");
                    table.AddColumn("updt");
                    table.AddColumn("dist");
                    table.AddColumn("enId");

                    foreach (var p in BasePlayer.activePlayerList)
                    {
                        if (p == null || !p.IsValid()) continue;
                        string id = p.UserIDString;
                        string name = p.displayName ?? "";
                        if (name.Length >= 14) name = name.Substring(0, 14) + "..";
                        int ping;
                        var conn = p.net?.connection;
                        BotInfo bp_info;
                        bool isBot = _instance._bots.TryGetValue(p.userID, out bp_info);
                        if (isBot || conn == null) ping = GetBotDisplayPing(bp_info);
                        else
                        {
                            try { ping = Network.Net.sv.GetAveragePing(conn); }
                            catch { ping = 0; }
                        }
                        int upd = 0, dist = 0;
                        try { upd = p.GetQueuedUpdateCount(BasePlayer.NetworkQueue.Update); } catch { }
                        try { dist = p.GetQueuedUpdateCount(BasePlayer.NetworkQueue.UpdateDistance); } catch { }
                        ulong enId = (p.net != null ? p.net.ID.Value : 0UL);
                        table.AddRow(id, name, ping.ToString(), upd.ToString(), dist.ToString(), enId.ToString());
                    }

                    arg.ReplyWith(json ? table.ToJson(stringify: false) : table.ToString());
                }
                return false;
            }
            catch (Exception ex)
            {
                _instance.PrintWarning($"PlayersPrefix failed: {ex.Message}");
                return true;
            }
        }

        #endregion

        #region Reflection

        // Locate the private backing field inside an EncryptedValue<T>-style
        // wrapper struct. We probe the historical name `_value` first, then
        // fall back to "the only private instance field whose type matches
        // T". The wrapper carries a single payload of that type plus an
        // unrelated key field, so the type filter is enough to disambiguate
        // when Facepunch renames the field on a Rust update.
        private static FieldInfo FindEncryptedBackingField(Type wrapperType, Type payloadType)
        {
            if (wrapperType == null || payloadType == null) return null;

            var byName = wrapperType.GetField("_value",
                BindingFlags.NonPublic | BindingFlags.Instance);
            if (byName != null && byName.FieldType == payloadType)
                return byName;

            FieldInfo match = null;
            int matchCount = 0;
            foreach (var f in wrapperType.GetFields(
                BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Public))
            {
                if (f.FieldType != payloadType) continue;
                match = f;
                matchCount++;
            }
            return matchCount == 1 ? match : null;
        }

        private void CacheReflection()
        {
            // Networkable.subscriber — used for RelationshipUpdateQueue etc.
            // BasePlayer.userID / displayName are encrypted wrappers; we
            // cache their backing fields here for fast reflection writes.
            var netField = typeof(BaseNetworkable).GetField("net",
                BindingFlags.Public | BindingFlags.Instance);
            if (netField != null)
            {
                var networkableType = netField.FieldType;

                _netSubscriberField = networkableType.GetField("subscriber",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                if (_netSubscriberField == null)
                {
                    foreach (var f in networkableType.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance))
                    {
                        if (f.FieldType.Name.Contains("Subscriber"))
                        {
                            _netSubscriberField = f;
                            break;
                        }
                    }
                }
            }

            // BasePlayer.userID — EncryptedValue<ulong>. The internal backing
            // field has historically been named `_value`, but Facepunch
            // periodically renames or obfuscates it. We probe the well-known
            // names first, then fall back to "any private ulong field" — the
            // wrapper struct only carries a single value field of that type
            // plus a key, so the type-based lookup is reliable.
            _userIdField = typeof(BasePlayer).GetField("userID",
                BindingFlags.Public | BindingFlags.Instance);
            if (_userIdField != null)
            {
                _encryptedValueField = FindEncryptedBackingField(_userIdField.FieldType, typeof(ulong));
            }

            // BasePlayer.displayName — may be field or property; if a field,
            // it can be either a plain string or an EncryptedValue<string>.
            _displayNameField = typeof(BasePlayer).GetField("displayName",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            if (_displayNameField != null)
            {
                if (_displayNameField.FieldType != typeof(string))
                {
                    _displayNameEncryptedField = FindEncryptedBackingField(_displayNameField.FieldType, typeof(string));
                }
            }
            else
            {
                // Try as property
                _displayNameProperty = typeof(BasePlayer).GetProperty("displayName",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                if (_displayNameProperty == null)
                {
                    // Search by name pattern
                    foreach (var p in typeof(BasePlayer).GetProperties(BindingFlags.Public | BindingFlags.Instance))
                    {
                        if (p.Name.ToLower().Contains("displayname") || p.Name.ToLower().Contains("display_name"))
                        {
                            _displayNameProperty = p;
                            break;
                        }
                    }
                }
            }

            // BasePlayer.lastTickTime — private float, used for timeout kick
            // Name is obfuscated, find via timeSinceLastTick property getter IL
            _lastTickTimeField = typeof(BasePlayer).GetField("lastTickTime",
                BindingFlags.NonPublic | BindingFlags.Instance);
            if (_lastTickTimeField == null)
            {
                // Obfuscated: collect all float-field ldfld references in timeSinceLastTick getter
                var prop = typeof(BasePlayer).GetProperty("timeSinceLastTick",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                var getter = prop?.GetGetMethod(true);
                var body = getter?.GetMethodBody();
                if (body != null)
                {
                    var il = body.GetILAsByteArray();
                    var candidates = new List<FieldInfo>();
                    for (int i = 0; i <= il.Length - 5; i++)
                    {
                        if (il[i] != 0x7B) continue; // ldfld
                        int token = il[i + 1] | (il[i + 2] << 8) | (il[i + 3] << 16) | (il[i + 4] << 24);
                        try
                        {
                            var resolved = typeof(BasePlayer).Module.ResolveField(token);
                            if (resolved != null
                                && resolved.FieldType == typeof(float)
                                && resolved.DeclaringType == typeof(BasePlayer)
                                && !candidates.Contains(resolved))
                            {
                                candidates.Add(resolved);
                            }
                        }
                        catch { }
                    }

                    // Prefer name containing "tick"; else take the last ldfld
                    // (timeSinceLastTick = Time.time - lastTickTime → lastTickTime is the last ldfld before sub)
                    FieldInfo picked = null;
                    foreach (var c in candidates)
                    {
                        if (c.Name.IndexOf("tick", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            picked = c;
                            break;
                        }
                    }
                    if (picked == null && candidates.Count > 0)
                        picked = candidates[candidates.Count - 1];

                    _lastTickTimeField = picked;
                    Log($"Reflection: lastTickTime candidates={candidates.Count}, picked={picked?.Name ?? "null"}");
                }
            }

            string displayNameSource;
            if (_displayNameEncryptedField != null) displayNameSource = "field._value=" + _displayNameEncryptedField.Name;
            else if (_displayNameField != null) displayNameSource = "field=" + _displayNameField.Name + "(" + _displayNameField.FieldType.Name + ")";
            else if (_displayNameProperty != null) displayNameSource = "property=" + _displayNameProperty.Name;
            else displayNameSource = "FAIL";

            Puts($"[Reflection] subscriber={_netSubscriberField?.Name ?? "FAIL"}, " +
                 $"userID._value={_encryptedValueField?.Name ?? "FAIL"} (type={_userIdField?.FieldType?.Name ?? "?"}), " +
                 $"displayName={displayNameSource}, " +
                 $"lastTickTime={_lastTickTimeField?.Name ?? "FAIL"}");

            // Hard warning if userID rewrite path is broken — without it,
            // every spawned bot keeps Rust's auto-assigned NPC id (<10M),
            // which is exactly the symptom that surfaces as `368:"368"` in
            // the vanilla `users` console command output.
            if (_userIdField == null || _encryptedValueField == null)
                PrintError("[Reflection] BasePlayer.userID backing field NOT FOUND. " +
                           "Bots will keep auto-assigned NPC ids and appear as `<id>:\"<id>\"` in `users`. " +
                           "Likely cause: Facepunch renamed the inner field of EncryptedValue<ulong>.");
            if (_displayNameField == null && _displayNameProperty == null)
                PrintError("[Reflection] BasePlayer.displayName setter NOT FOUND — bot names will not stick.");
            if (_netSubscriberField == null)
                PrintWarning("[Reflection] subscriber field not found — bots may NRE in ShouldNetworkTo.");
        }

        private void SetUserID(BasePlayer player, ulong steamId)
        {
            if (_userIdField == null || _encryptedValueField == null)
            {
                PrintError("SetUserID: reflection not cached");
                return;
            }

            // EncryptedValue is a struct — must box, modify, set back
            object encrypted = _userIdField.GetValue(player);
            _encryptedValueField.SetValue(encrypted, steamId);
            _userIdField.SetValue(player, encrypted);
        }

        private void SetDisplayName(BasePlayer player, string name)
        {
            if (_displayNameField != null)
            {
                if (_displayNameEncryptedField != null)
                {
                    object encrypted = _displayNameField.GetValue(player);
                    _displayNameEncryptedField.SetValue(encrypted, name);
                    _displayNameField.SetValue(player, encrypted);
                }
                else
                {
                    _displayNameField.SetValue(player, name);
                }
                Log($"SetDisplayName via field: {name}");
            }
            else if (_displayNameProperty != null && _displayNameProperty.CanWrite)
            {
                _displayNameProperty.SetValue(player, name);
                Log($"SetDisplayName via property: {name}");
            }
            else
            {
                // Last resort: try direct assignment (compiler resolves at compile time)
                player.displayName = name;
                Log($"SetDisplayName via direct: {name}");
            }
        }

        private void InitSubscriber(BasePlayer player)
        {
            if (_netSubscriberField == null || player.net == null) return;

            var current = _netSubscriberField.GetValue(player.net);
            if (current != null) return;

            try
            {
                var subscriberType = _netSubscriberField.FieldType;
                var instance = Activator.CreateInstance(subscriberType);
                _netSubscriberField.SetValue(player.net, instance);
                Log($"InitSubscriber: created {subscriberType.Name}");
            }
            catch (Exception ex)
            {
                PrintWarning($"InitSubscriber failed: {ex.Message}");
            }
        }

        #endregion

        #region Steam Auth

        private static string AuthReason(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 64) return "unspecified";
            foreach (char c in value) if ((c < 'a' || c > 'z') && c != '_') return "unspecified";
            return value;
        }

        private void AuthAudit(ulong steamId, string operation, string reason = null, string response = null, bool? accepted = null)
        {
            try
            {
                AuthTrace trace;
                _authTraces.TryGetValue(steamId, out trace);
                string detail = JsonConvert.SerializeObject(new {
                    operation, attemptId = trace?.AttemptId, ticketFingerprint = trace?.Fingerprint,
                    reason = reason == null ? null : AuthReason(reason), response, accepted,
                    observedAt = DateTime.UtcNow.ToString("o"),
                    association = operation == "validate_callback" ? "current_attempt_unverified" : "local_operation"
                });
                Puts($"[AUTH-AUDIT] {steamId} {detail}");
                SendEvent(steamId, "auth_diagnostic", detail);
            }
            catch { /* Diagnostics must not change authentication behavior. */ }
        }

        private bool BeginSteamSession(ulong steamId, string ticketHex, string attemptId = null)
        {
            try
            {
                byte[] ticketData = HexToBytes(ticketHex);
                if (ticketData == null || ticketData.Length == 0)
                {
                    PrintWarning($"BeginSteamSession: invalid ticket hex for {steamId}");
                    return false;
                }
                Guid suppliedId;
                string safeId = Guid.TryParse(attemptId, out suppliedId) ? suppliedId.ToString("D") : Guid.NewGuid().ToString("D");
                string fingerprint;
                using (var sha = System.Security.Cryptography.SHA256.Create())
                    fingerprint = BitConverter.ToString(sha.ComputeHash(ticketData)).Replace("-", "").ToLowerInvariant().Substring(0, 24);
                if (!_authTraces.ContainsKey(steamId))
                {
                    _authTraceOrder.Enqueue(steamId);
                    if (_authTraceOrder.Count > 4096) _authTraces.Remove(_authTraceOrder.Dequeue());
                }
                _authTraces[steamId] = new AuthTrace { AttemptId = safeId, Fingerprint = fingerprint };
                AuthAudit(steamId, "begin_requested");
                bool ok = SteamServer.BeginAuthSession(ticketData, steamId);
                AuthAudit(steamId, "begin_result", accepted: ok);
                if (ok)
                {
                    _steamAuthBegun++;
                    _steamAuthBeginAt[steamId] = TimeEx.realtimeSinceStartup;
                    Log($"[STEAMAUTH] BeginAuthSession ACCEPTED {steamId} (ticket {ticketData.Length}B) t={TimeEx.realtimeSinceStartup:F1} — awaiting OnValidateAuthTicketResponse | begun={_steamAuthBegun} respOk={_steamAuthRespOk} respFail={_steamAuthRespFail}");
                }
                else
                {
                    PrintWarning($"[STEAMAUTH] BeginAuthSession REJECTED {steamId} (ticket {ticketData.Length}B) — Steam refused ticket SYNCHRONOUSLY (malformed/expired ticket, no callback will come)");
                }
                return ok;
            }
            catch (Exception ex)
            {
                AuthAudit(steamId, "begin_error");
                PrintWarning($"BeginSteamSession exception: {ex.Message}");
                return false;
            }
        }

        private void EndSteamSession(ulong steamId, string reason = "unspecified")
        {
            AuthAudit(steamId, "end_requested", reason);
            try
            {
                SteamServer.EndSession(steamId);
                AuthAudit(steamId, "end_returned", reason);
            }
            catch { AuthAudit(steamId, "end_error", reason); }
        }

        // Эмиттит server.player_connect в Facepunch analytics gateway. Backend сшивает
        // это событие с client.session.start / client.client_performance бота по steam_id
        // → бот учитывается в playerCount. Реальный flow в Auth_Steam.Run → ClientReady
        // вызывает Analytics.Azure.OnPlayerConnected(connection) — мы воспроизводим тот
        // же EventRecord, минуя Steam handshake (бот заходит через rne.register, не
        // через настоящий Raknet+BeginAuthSession). См. source/docs/RUST-ANALYTICS-API.md.
        private void EmitPlayerConnectAnalytics(ulong steamId, string displayName, string ipAddress)
        {
            try
            {
                string userWipeId = SingletonComponent<ServerMgr>.Instance.persistance.GetUserWipeId(steamId);
                Facepunch.Rust.EventRecord.New("player_connect")
                    .AddField("player_userid", userWipeId)
                    .AddField("steam_id", steamId)
                    .AddField("username", displayName)
                    .AddField("ip", ipAddress)
                    .Submit();
                Puts($"Analytics: player_connect emitted for {steamId} ({displayName})");
            }
            catch (Exception ex)
            {
                PrintWarning($"EmitPlayerConnectAnalytics failed for {steamId}: {ex.Message}");
            }
        }

        // Эмиттит server.player_disconnect. Вызывать ТОЛЬКО на реальный exit бота со
        // сервера (rne.unregister), а не на death/respawn/zombie-cleanup. См. план:
        // RemoveBot и RespawnBot триггерить этот emit НЕЛЬЗЯ (real client при смерти
        // не шлёт player_disconnect — это та же сессия). Кроме этого балансируем
        // lifecycle при re-register: на старом «зомби» сначала шлём disconnect.
        private void EmitPlayerDisconnectAnalytics(ulong steamId, string displayName, string reason)
        {
            try
            {
                string userWipeId = SingletonComponent<ServerMgr>.Instance.persistance.GetUserWipeId(steamId);
                Facepunch.Rust.EventRecord.New("player_disconnect")
                    .AddField("player_userid", userWipeId)
                    .AddField("steam_id", steamId)
                    .AddField("username", displayName)
                    .AddField("reason", reason)
                    .Submit();
                Puts($"Analytics: player_disconnect emitted for {steamId} (reason={reason})");
            }
            catch (Exception ex)
            {
                PrintWarning($"EmitPlayerDisconnectAnalytics failed for {steamId}: {ex.Message}");
            }
        }

        #region FP server-event dump

        // Apply a Harmony postfix to one Facepunch.Rust.Analytics.Azure emitter.
        // Resolved by explicit signature so an overload shuffle across Rust
        // updates can't bind us to the wrong method. No-op (warns) if absent.
        private void PatchAnalyticsDump(Type azureType, string methodName, string postfixName, Type[] sig)
        {
            try
            {
                var m = azureType.GetMethod(methodName,
                    BindingFlags.Public | BindingFlags.Static, null, sig, null);
                if (m == null) { PrintWarning($"Analytics.Azure.{methodName} not found — dump skipped"); return; }
                var postfix = typeof(AdminLogger).GetMethod(postfixName, BindingFlags.NonPublic | BindingFlags.Static);
                _harmony.Patch(m, postfix: new HarmonyMethod(postfix));
                Log($"Harmony: patched Analytics.Azure.{methodName} (FP event dump)");
            }
            catch (Exception ex) { PrintWarning($"Patch Analytics.Azure.{methodName}: {ex.Message}"); }
        }

        // Mirrors Analytics.Azure.OnPlayerConnected's AddField set.
        private static void OnPlayerConnectedDumpPostfix(Connection __0)
        {
            if (_instance == null || __0 == null) return;
            try
            {
                _instance.DumpFacepunchServerEvent("player_connect", __0.userid, new
                {
                    player_userid = _instance.SafeWipeId(__0.userid),
                    steam_id = __0.userid.ToString(),
                    username = __0.username,
                    ip = __0.ipaddress,
                });
            }
            catch { }
        }

        // Mirrors Analytics.Azure.OnPlayerDisconnected(connection, reason).
        private static void OnPlayerDisconnectedDumpPostfix(Connection __0, string __1)
        {
            if (_instance == null || __0 == null) return;
            try
            {
                _instance.DumpFacepunchServerEvent("player_disconnect", __0.userid, new
                {
                    player_userid = _instance.SafeWipeId(__0.userid),
                    steam_id = __0.userid.ToString(),
                    username = __0.username,
                    reason = __1,
                });
            }
            catch { }
        }

        // Mirrors Analytics.Azure.OnSteamAuth(userId, ownerUserId, authResponse).
        private static void OnSteamAuthDumpPostfix(ulong __0, ulong __1, string __2)
        {
            if (_instance == null) return;
            try
            {
                var sv = global::Network.Net.sv;
                // Nullable (?.) on the sv reads so the anonymous type doesn't
                // force an int/uint literal-fallback mismatch; sv is never null
                // inside a real steam_auth callback, but stay NRE-proof anyway.
                _instance.DumpFacepunchServerEvent("steam_auth", __0, new
                {
                    user = __0.ToString(),
                    owner = __1.ToString(),
                    response = __2,
                    server_port = sv?.port,
                    network_mode = sv?.ProtocolId,
                    player_count = BasePlayer.activePlayerList.Count,
                    max_players = ConVar.Server.maxplayers,
                    hostname = ConVar.Server.hostname,
                    secure = sv?.secure,
                });
            }
            catch { }
        }

        // Resolve a player's per-wipe id exactly as the vanilla emitters do.
        // Swallows any error (persistance not ready) — the dump still goes out
        // with player_userid=null rather than losing the event.
        private string SafeWipeId(ulong steamId)
        {
            try { return SingletonComponent<ServerMgr>.Instance?.persistance?.GetUserWipeId(steamId); }
            catch { return null; }
        }

        private string _fpDumpDir;

        // Central sink for the FP server-event dump. Stamps the event with a
        // millisecond UTC timestamp + server realtime (for cross-channel timing
        // diffs vs the bot's emitted events) and fans it out to three places:
        //   1. console  — live visibility
        //   2. oxide/logs/AdminLogger/fp_events-YYYY-MM-DD.log — persistent JSONL
        //   3. controller over WS — event type "fp_server_event"
        // All Analytics.Azure.On* callers run on the main thread, so console /
        // file / WS access here is single-threaded and safe.
        private void DumpFacepunchServerEvent(string eventName, ulong steamId, object fields)
        {
            if (_config?.DumpFacepunchServerEvents == false) return;
            try
            {
                var now = DateTime.UtcNow;
                string ts = now.ToString("yyyy-MM-ddTHH:mm:ss.fffZ",
                    System.Globalization.CultureInfo.InvariantCulture);
                var record = new
                {
                    ts,
                    unix_ms = ((DateTimeOffset)now).ToUnixTimeMilliseconds(),
                    realtime = UnityEngine.Time.realtimeSinceStartup,
                    @event = eventName,
                    fields,
                };
                // Json.NET formats numbers with the invariant culture, so no
                // ru-RU "12,4" surprises in the dumped floats.
                string line = JsonConvert.SerializeObject(record);

                Puts($"[FP-EVENT] {ts} {eventName} {JsonConvert.SerializeObject(fields)}");
                AppendFacepunchDump(line);
                SendEvent(steamId, "fp_server_event", line);
            }
            catch (Exception ex) { PrintWarning($"DumpFacepunchServerEvent({eventName}): {ex.Message}"); }
        }

        // Append one JSONL record to the dated dump file. Best-effort: a failed
        // write is logged at debug level only — it must never break the patched
        // analytics call we're riding on.
        private void AppendFacepunchDump(string line)
        {
            try
            {
                if (string.IsNullOrEmpty(_fpDumpDir))
                {
                    _fpDumpDir = System.IO.Path.Combine(Interface.Oxide.LogDirectory, "AdminLogger");
                    System.IO.Directory.CreateDirectory(_fpDumpDir);
                }
                string file = System.IO.Path.Combine(_fpDumpDir,
                    $"fp_events-{DateTime.UtcNow:yyyy-MM-dd}.log");
                System.IO.File.AppendAllText(file, line + Environment.NewLine);
            }
            catch (Exception ex) { Log($"AppendFacepunchDump failed: {ex.Message}"); }
        }

        #endregion

        // Try to register the player name via Rust's own PlatformService.Instance.UpdatePlayerSession
        // as a backup to SteamServer.UpdatePlayer. Uses reflection because PlatformService lives in
        // Facepunch.Rust/Assembly-CSharp and may not be directly accessible at compile time.
        private static MethodInfo _platformUpdateSessionMethod;
        private static object _platformInstance;
        private static bool _platformLookupDone;

        private void TryUpdatePlatformPlayerSession(ulong steamId, string name)
        {
            try
            {
                if (!_platformLookupDone)
                {
                    _platformLookupDone = true;
                    Type platformType = null;
                    // PlatformService lives in Rust.Platform.Steam.dll (separate assembly). Search all loaded.
                    foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                    {
                        try
                        {
                            platformType = asm.GetType("PlatformService");
                            if (platformType != null) break;
                            foreach (var t in asm.GetTypes())
                            {
                                if (t.Name == "PlatformService" && !t.IsInterface && !t.IsAbstract)
                                {
                                    platformType = t;
                                    break;
                                }
                            }
                            if (platformType != null) break;
                        }
                        catch { }
                    }
                    if (platformType != null)
                    {
                        var instanceProp = platformType.GetProperty("Instance",
                            BindingFlags.Public | BindingFlags.Static);
                        _platformInstance = instanceProp?.GetValue(null);
                        if (_platformInstance == null)
                        {
                            var instanceField = platformType.GetField("Instance",
                                BindingFlags.Public | BindingFlags.Static);
                            _platformInstance = instanceField?.GetValue(null);
                        }
                        if (_platformInstance != null)
                        {
                            _platformUpdateSessionMethod = _platformInstance.GetType().GetMethod(
                                "UpdatePlayerSession",
                                BindingFlags.Public | BindingFlags.Instance);
                            // also try via interface map (instance method may be on interface)
                            if (_platformUpdateSessionMethod == null)
                            {
                                foreach (var iface in _platformInstance.GetType().GetInterfaces())
                                {
                                    _platformUpdateSessionMethod = iface.GetMethod("UpdatePlayerSession");
                                    if (_platformUpdateSessionMethod != null) break;
                                }
                            }
                        }
                        Log($"PlatformService lookup: type={platformType.FullName}, " +
                            $"instance={(_platformInstance != null ? _platformInstance.GetType().FullName : "null")}, " +
                            $"method={(_platformUpdateSessionMethod != null ? "OK" : "null")}");
                    }
                    else
                    {
                        Log("PlatformService type not found (searched all loaded assemblies)");
                    }
                }

                if (_platformInstance != null && _platformUpdateSessionMethod != null)
                {
                    _platformUpdateSessionMethod.Invoke(_platformInstance, new object[] { steamId, name });
                    Log($"PlatformService.UpdatePlayerSession: {steamId} -> '{name}'");
                }
            }
            catch (Exception ex)
            {
                Log($"TryUpdatePlatformPlayerSession exception: {ex.InnerException?.Message ?? ex.Message}");
            }
        }

        private static byte[] HexToBytes(string hex)
        {
            if (string.IsNullOrEmpty(hex) || hex.Length % 2 != 0) return null;
            byte[] bytes = new byte[hex.Length / 2];
            for (int i = 0; i < bytes.Length; i++)
                bytes[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
            return bytes;
        }

        #endregion

        #region Bot Management

        // Synchronously remove any BasePlayer (active, sleeper, or orphan in allPlayerList)
        // with the given steamId so the userID is free before spawning a new bot with the same ID.
        private void PurgeExistingForSteamId(ulong steamId)
        {
            var victims = new List<BasePlayer>(4);

            // 1. Direct lookups
            var active = BasePlayer.FindByID(steamId);
            if (active != null && !active.IsDestroyed) victims.Add(active);
            var sleeper = BasePlayer.FindSleeping(steamId);
            if (sleeper != null && !sleeper.IsDestroyed && !victims.Contains(sleeper)) victims.Add(sleeper);

            // 2. Orphans: scan allPlayerList (covers entities that are in activePlayerLookup
            // but not reachable via FindByID due to inconsistent state from a previous failed CreateBot)
            try
            {
                if (BasePlayer.allPlayerList != null)
                {
                    foreach (var p in BasePlayer.allPlayerList)
                    {
                        if (p == null || p.IsDestroyed) continue;
                        if (p.userID == steamId && !victims.Contains(p))
                            victims.Add(p);
                    }
                }
            }
            catch (Exception ex) { Log($"Purge scan failed: {ex.Message}"); }

            // 3. Directly clear activePlayerLookup slot regardless of whether we found an entity,
            // in case it holds a stale reference.
            try { BasePlayer.activePlayerLookup.Remove(steamId); } catch { }

            foreach (var v in victims)
            {
                Log($"Purging existing entity {v.GetType().Name} for {steamId}");
                try { v.limitNetworking = true; } catch { }
                try { BasePlayer.activePlayerList.Remove(v); } catch { }
                try { BasePlayer.activePlayerLookup.Remove(steamId); } catch { }
                try { v.Kill(); } catch { }
                try
                {
                    if (v != null && v.gameObject != null)
                        UnityEngine.Object.DestroyImmediate(v.gameObject, true);
                }
                catch (Exception ex)
                {
                    Log($"DestroyImmediate failed for {steamId}: {ex.Message}");
                }
            }

            // Final double-check
            try { BasePlayer.activePlayerLookup.Remove(steamId); } catch { }

            if (BasePlayer.FindByID(steamId) != null || BasePlayer.FindSleeping(steamId) != null)
                PrintWarning($"PurgeExistingForSteamId: {steamId} still present after purge");
        }

        private BasePlayer CreateBot(ulong steamId, string displayName, string ipAddress)
        {
            Log($"CreateBot: {displayName} ({steamId}) ip={ipAddress}");

            if (_bots.ContainsKey(steamId))
            {
                PrintWarning($"Bot {steamId} already registered");
                return null;
            }

            // Purge any stale BasePlayer (sleeper / leftover from previous plugin load / corpse-respawn leftover)
            // BEFORE checking activePlayerLookup, otherwise respawn races with the Kill() of the previous entity.
            // Refuse collisions with real players, including sleeping entities.
            foreach (var existing in BasePlayer.allPlayerList)
            {
                if (existing != null && !existing.IsDestroyed && existing.userID == steamId
                    && !(existing is AdminBot))
                {
                    PrintWarning($"CreateBot refused: existing player entity for {steamId}");
                    return null;
                }
            }
            PurgeExistingForSteamId(steamId);

            if (BasePlayer.activePlayerLookup.ContainsKey(steamId))
            {
                PrintWarning($"Player {steamId} still in activePlayerLookup after purge");
                return null;
            }

            // Spawn at random point across the entire map
            Vector3 pos = GetRandomMapPosition();

            // Create AdminBot entity (FrankensteinPet-based, IsNpc=false)
            var player = CreateAdminBot(pos, Quaternion.Euler(0, UnityEngine.Random.Range(0f, 360f), 0));
            if (player == null)
            {
                PrintError("Failed to create AdminBot entity");
                return null;
            }

            // Set userID BEFORE Spawn() — prevents ServerInit from assigning bot ID (<10M)
            SetUserID(player, steamId);
            player.UserIDString = steamId.ToString();
            SetDisplayName(player, displayName);

            // Sanity check: if SetUserID didn't actually rewrite the encrypted
            // backing field (Facepunch may have renamed it), the entity will
            // keep Rust's auto-assigned NPC id and surface as `<id>:"<id>"`
            // in the vanilla `users` console output. Fail loud here rather
            // than registering a broken bot in _bots.
            ulong actualId = 0UL;
            try { actualId = player.userID.Get(); } catch { }
            if (actualId != steamId)
            {
                PrintError($"CreateBot: SetUserID failed — expected {steamId} but BasePlayer.userID still reads {actualId}. " +
                           $"Reflection backing field is wrong; check the [Reflection] line in plugin load logs.");
                try { UnityEngine.Object.DestroyImmediate(player.gameObject, true); } catch { }
                return null;
            }

            // Spawn dead + limited networking to prevent premature broadcasts
            player.health = 0f;
            player.lifestate = BaseCombatEntity.LifeState.Dead;
            player.ResetLifeStateOnSpawn = false;
            player.limitNetworking = true;

            Log($"Spawning entity (limitNetworking=true, occlusion disabled)");
            bool wasOcclusion = ServerOcclusion.OcclusionEnabled;
            ServerOcclusion.OcclusionEnabled = false;
            player.Spawn();
            ServerOcclusion.OcclusionEnabled = wasOcclusion;
            Log($"Entity spawned: netID={player.net?.ID}, group={player.net?.group?.ID}");

            // Phase A: NO fake Connection, NO Net.sv.connections.Add.
            // Browser visibility comes from:
            //   - player count: BasePlayer.activePlayerList.Count → GameTags "cp..."
            //   - names: Steamworks native A2S_PLAYER handler reads names registered via
            //     SteamServer.UpdatePlayer / PlatformService.UpdatePlayerSession
            try
            {
                SteamServer.UpdatePlayer(steamId, displayName, 0);
                Log($"SteamServer.UpdatePlayer: {steamId} -> '{displayName}'");
            }
            catch (Exception ex)
            {
                PrintWarning($"SteamServer.UpdatePlayer failed: {ex.Message}");
            }

            // Safety: also try PlatformService.Instance.UpdatePlayerSession via reflection
            // (this is the path Rust server itself uses in Auth_Steam.cs after successful auth)
            TryUpdatePlatformPlayerSession(steamId, displayName);

            // Initialize subscriber (prevents NullRef in ShouldNetworkTo)
            InitSubscriber(player);

            // Enable networking and move from LimboNetworkGroup to correct position-based group
            player.limitNetworking = false;
            bool wasOcclusion2 = ServerOcclusion.OcclusionEnabled;
            ServerOcclusion.OcclusionEnabled = false;
            player.UpdateNetworkGroup();
            ServerOcclusion.OcclusionEnabled = wasOcclusion2;
            Log($"Network group updated: group={player.net?.group?.ID}, limitNetworking={player.limitNetworking}");

            // Ensure the address used in status/playerlist output has a port (random if caller didn't supply one)
            string ipWithPort = ipAddress.Contains(":")
                ? ipAddress
                : ipAddress + ":" + UnityEngine.Random.Range(50000, 60001);

            // Register in _bots BEFORE activePlayerList.Add so our Harmony prefixes
            // for ServerUpdate/PlayerUpdate skip the bot on the very first tick
            // after it becomes visible to Rust's per-player job system. Without
            // this, the first `PlayerUpdate` job after Add sees a not-yet-fully-
            // initialized bot (inventory/metabolism/flags set further below) and
            // logs "Server Exception: Player Update" NREs until a subsequent
            // unregister/reregister cycle resyncs the PlayerCache.
            _bots[steamId] = new BotInfo
            {
                Player = player,
                DisplayName = displayName,
                IpAddress = ipWithPort,
                OriginalConnectionTime = TimeEx.realtimeSinceStartup
            };

            // Register in active lists
            BasePlayer.activePlayerList.Add(player);
            BasePlayer.activePlayerLookup[steamId] = player;

            // Flags — alive and connected
            player.SetPlayerFlag(BasePlayer.PlayerFlags.Connected, true);
            player.SetPlayerFlag(BasePlayer.PlayerFlags.ReceivingSnapshot, false);
            player.SetPlayerFlag(BasePlayer.PlayerFlags.Sleeping, false);

            // Persist
            SingletonComponent<ServerMgr>.Instance.persistance.SetPlayerName(steamId, displayName);

            // Alive with health
            player.health = 100f;
            player.lifestate = BaseCombatEntity.LifeState.Alive;
            player.metabolism.hydration.SetValue(200f);
            player.metabolism.calories.SetValue(300f);

            // Default inventory — only rock and torch in belt
            player.inventory.Strip();
            var rock = ItemManager.CreateByName("rock", 1);
            var torch = ItemManager.CreateByName("torch", 1);
            if (rock != null) player.inventory.GiveItem(rock, player.inventory.containerBelt);
            if (torch != null) player.inventory.GiveItem(torch, player.inventory.containerBelt);

            // Enable physics — bot walks, not sleeps.
            // SetPlayerRigidbodyState became `private` on BasePlayer in the
            // Aug-2026 build — a direct call no longer compiles. Invoke via
            // reflection, same pattern as OcclusionInitGroup below.
            try
            {
                var sprs = typeof(BasePlayer).GetMethod("SetPlayerRigidbodyState",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                if (sprs != null) sprs.Invoke(player, new object[] { true });
                else PrintWarning("SetPlayerRigidbodyState not found — bot physics state not set");
            }
            catch (Exception ex) { PrintWarning($"SetPlayerRigidbodyState: {ex.Message}"); }

            // Register in occlusion system (same as PlayerInit does)
            if (ServerOcclusion.OcclusionEnabled && player.SupportsServerOcclusion())
            {
                try
                {
                    var occMethod = typeof(BaseNetworkable).GetMethod("OcclusionInitGroup",
                        BindingFlags.NonPublic | BindingFlags.Instance);
                    occMethod?.Invoke(player, new object[] { false });
                    Log("OcclusionInitGroup: OK");
                }
                catch (Exception ex)
                {
                    PrintWarning($"OcclusionInitGroup: {ex.InnerException?.Message ?? ex.Message}");
                }
            }

            // Force-send entity snapshot to all connected real players
            int snapshotsSent = 0;
            player.SendNetworkUpdateImmediate();
            foreach (var conn in Network.Net.sv.connections)
            {
                if (conn.active && conn.player != null && conn.player != player)
                {
                    player.SendAsSnapshot(conn);
                    snapshotsSent++;
                }
            }
            Log($"Sent {snapshotsSent} snapshots to connected players");

            // Bot sleeps at spawn point
            player.SetPlayerFlag(BasePlayer.PlayerFlags.Sleeping, true);

            Puts($"Bot registered: {displayName} ({steamId}) at {pos}, IP={ipAddress}");
            SendEvent(steamId, "bot_registered", $"{pos.x:F0},{pos.y:F0},{pos.z:F0}");
            return player;
        }

        private void RespawnBot(ulong steamId)
        {
            if (!_bots.TryGetValue(steamId, out var botInfo)) return;
            Log($"RespawnBot: {botInfo.DisplayName} ({steamId}), steamSession={botInfo.HasSteamSession}");

            // Full kill + recreate to avoid stale network state
            var oldPlayer = botInfo.Player;
            string displayName = botInfo.DisplayName;
            string ipAddress = botInfo.IpAddress;
            double savedConnectionTime = botInfo.OriginalConnectionTime;
            bool hadSteamSession = botInfo.HasSteamSession;
            string savedTicketHex = botInfo.AuthTicketHex;

            // Remove from _bots BEFORE Kill() to prevent OnEntityDeath from scheduling another respawn
            _bots.Remove(steamId);

            // Clean up old entity (no fake connection anymore, so just active-list cleanup + kill)
            if (oldPlayer != null && !oldPlayer.IsDestroyed)
            {
                BasePlayer.activePlayerList.Remove(oldPlayer);
                BasePlayer.activePlayerLookup.Remove(steamId);
                try { oldPlayer.net?.CloseSubscriber(); } catch { }
                if (_netSubscriberField != null && oldPlayer.net != null)
                    try { _netSubscriberField.SetValue(oldPlayer.net, null); } catch { }
                oldPlayer.limitNetworking = true;
                try { oldPlayer.Kill(); } catch { }
            }

            // Recreate
            var newPlayer = CreateBot(steamId, displayName, ipAddress);
            if (newPlayer == null)
            {
                PrintWarning($"Failed to respawn bot {steamId}");
                SendEvent(steamId, "bot_respawn_failed");
            }
            else
            {
                // Restore original connection time so connected duration doesn't reset
                _bots[steamId].OriginalConnectionTime = savedConnectionTime;
                _bots[steamId].HasSteamSession = hadSteamSession;
                _bots[steamId].AuthTicketHex = savedTicketHex;
                Puts($"Bot {displayName} ({steamId}) respawned");
                SendEvent(steamId, "bot_respawned");
            }
        }

        private bool RemoveBot(ulong steamId, bool silent = false, bool preserveSteamSession = false, string reason = "remove_bot")
        {
            if (!_bots.TryGetValue(steamId, out var botInfo))
            {
                if (!silent) PrintWarning($"Bot {steamId} not found");
                return false;
            }

            // Remove ownership before Kill so its death hook cannot schedule a new spawn.
            _bots.Remove(steamId);
            var player = botInfo.Player;
            if (player == null || player.IsDestroyed)
            {
                _bots.Remove(steamId);
                // Failed validation also requires closing the server auth session.
                if (!preserveSteamSession) try { EndSteamSession(steamId, reason); } catch { }
                return true;
            }

            player.limitNetworking = true;
            if (!player.IsDestroyed)
                try { player.Kill(); } catch { }

            try { BasePlayer.activePlayerList.Remove(player); } catch { }
            try { BasePlayer.activePlayerLookup.Remove(steamId); } catch { }

            if (player.net != null)
            {
                try { player.net.CloseSubscriber(); } catch { }
                if (_netSubscriberField != null)
                    try { _netSubscriberField.SetValue(player.net, null); } catch { }
            }

            // End Steam auth session
            // Also close failed/pending sessions, except explicit in-place recreation.
            if (!preserveSteamSession) try { EndSteamSession(steamId, reason); } catch { }

            _bots.Remove(steamId);
            if (!silent)
            {
                Puts($"Bot unregistered: {steamId}");
                SendEvent(steamId, "bot_unregistered");
            }
            Log($"RemoveBot: {steamId} complete, steamSession={botInfo.HasSteamSession}");
            return true;
        }

        private Vector3 GetRandomMapPosition()
        {
            float halfSize = TerrainMeta.Size.x / 2f;
            // Shrink slightly to avoid spawning at map edge
            float margin = halfSize * 0.1f;
            float range = halfSize - margin;

            // Raycast mask: terrain, world (rocks/cliffs/props), construction, default
            int mask = LayerMask.GetMask("Terrain", "World", "Construction", "Default");

            for (int i = 0; i < 40; i++)
            {
                float x = UnityEngine.Random.Range(-range, range);
                float z = UnityEngine.Random.Range(-range, range);

                // 1. Skip bad topology first (cheap check)
                if (TerrainMeta.TopologyMap != null)
                {
                    int topology = TerrainMeta.TopologyMap.GetTopology(new Vector3(x, 0, z));
                    if ((topology & (int)(TerrainTopology.Enum.River | TerrainTopology.Enum.Lake |
                        TerrainTopology.Enum.Ocean | TerrainTopology.Enum.Offshore |
                        TerrainTopology.Enum.Building | TerrainTopology.Enum.Monument |
                        TerrainTopology.Enum.Clutter)) != 0)
                        continue;
                }

                // 2. Raycast from sky down to find real ground (top of rocks/cliffs, not under them)
                var origin = new Vector3(x, 500f, z);
                if (!UnityEngine.Physics.Raycast(origin, Vector3.down, out var hit, 1000f, mask, QueryTriggerInteraction.Ignore))
                    continue;

                Vector3 ground = hit.point;
                // Skip under water
                float waterY = TerrainMeta.WaterMap != null ? TerrainMeta.WaterMap.GetHeight(ground) : 0f;
                if (ground.y < waterY + 0.5f) continue;

                // 2a. Reject positions inside monument Prevent-Building colliders.
                // Topology mask above is coarse — monument perimeters (e.g. harbor,
                // oil rig) have PB colliders that extend past the topology flag.
                {
                    var around = UnityEngine.Physics.OverlapSphere(
                        ground + Vector3.up * 0.5f, 0.5f,
                        LayerMask.GetMask("Prevent Building"),
                        QueryTriggerInteraction.Collide);
                    bool inMonument = false;
                    foreach (var c in around)
                    {
                        if (c.GetComponentInParent<MonumentInfo>() != null) { inMonument = true; break; }
                    }
                    if (inMonument) continue;
                }

                // 3. Check hit surface is not a steep wall / ceiling (we want roughly horizontal ground)
                if (Vector3.Dot(hit.normal, Vector3.up) < 0.5f) continue;

                // 4. Ensure enough empty space above for the player capsule (~2m tall, 0.5m radius)
                Vector3 feet = ground + Vector3.up * 0.1f;
                Vector3 head = feet + Vector3.up * 1.8f;
                if (UnityEngine.Physics.CheckCapsule(feet + Vector3.up * 0.4f, head - Vector3.up * 0.4f, 0.45f, mask, QueryTriggerInteraction.Ignore))
                    continue;

                Log($"Spawn point found after {i + 1} tries: {feet}");
                return feet;
            }

            // Fallback — raycast at map center
            var fallbackOrigin = new Vector3(0f, 500f, 0f);
            if (UnityEngine.Physics.Raycast(fallbackOrigin, Vector3.down, out var fhit, 1000f, mask, QueryTriggerInteraction.Ignore))
            {
                PrintWarning("GetRandomMapPosition: using map-center fallback");
                return fhit.point + Vector3.up * 0.1f;
            }

            PrintWarning("GetRandomMapPosition: heightmap fallback (physics raycast failed)");
            float fy = TerrainMeta.HeightMap.GetHeight(Vector3.zero);
            return new Vector3(0, fy + 0.1f, 0);
        }

        #endregion

        #region RCON Commands

        [ConsoleCommand("rne.register")]
        private void CmdRegister(ConsoleSystem.Arg arg)
        {
            if (!arg.IsRcon && !arg.IsAdmin)
            {
                arg.ReplyWith("No permission");
                return;
            }

            if (!arg.HasArgs(4))
            {
                arg.ReplyWith("Usage: rne.register <steamId> <displayName> <ipAddress> <authTicketHex>");
                return;
            }

            if (!ulong.TryParse(arg.GetString(0), out ulong steamId))
            {
                arg.ReplyWith("Invalid steamId");
                return;
            }

            if (steamId < 10000000UL)
            {
                arg.ReplyWith("steamId must be > 10000000 (real Steam ID)");
                return;
            }

            string displayName = arg.GetString(1);
            string ipAddress = arg.GetString(2);
            string authTicketHex = arg.GetString(3);
            bool skipAuth = arg.HasArgs(5) && arg.GetString(4) == "noauth";

            // Idempotent re-register: если controller перезапустился без unbind, в _bots
            // остаётся зомби-запись с прошлой жизни. Сносим её до BeginSteamSession,
            // чтобы CreateBot не валился по `_bots.ContainsKey(steamId)`.
            // silent=true чтобы не отправить bot_unregistered: controller сейчас ждёт
            // ответ на rne.register, отдельное событие ему не нужно.
            //
            // Балансируем analytics lifecycle: для старой «зомби»-жизни шлём
            // player_disconnect ДО RemoveBot — иначе backend сохранит её player_connect
            // в актуальной сессии и новый player_connect воспримет как дубликат.
            if (_bots.TryGetValue(steamId, out var zombieInfo))
            {
                EmitPlayerDisconnectAnalytics(steamId, zombieInfo.DisplayName, "Disconnected");
                RemoveBot(steamId, silent: true, reason: "rcon_replace_entity");
            }

            if (skipAuth)
            {
                // Health-check re-register: Steam session already active, skip BeginAuthSession
                Log($"Register with noauth for {steamId}");
            }
            else
            {
                // Steam auth first — if it fails, don't create the bot
                if (!BeginSteamSession(steamId, authTicketHex))
                {
                    arg.ReplyWith($"FAIL {steamId} steam_auth_failed");
                    return;
                }
            }

            var player = SpawnBotByConfig(steamId, displayName, ipAddress);
            if (player == null)
            {
                if (!skipAuth)
                    EndSteamSession(steamId, "rcon_spawn_failed");
                arg.ReplyWith($"FAIL {steamId} create_failed");
                return;
            }

            _bots[steamId].HasSteamSession = !skipAuth;
            _bots[steamId].AuthTicketHex = authTicketHex;

            // Backend ждёт server-side player_connect для бота, иначе не учитывает
            // его в playerCount (даже при валидном steam_token и HTTP 200 на
            // client_performance).
            // Для auth-пути player_connect эмитится из ValidateAuthTicketPrefix ПОСЛЕ
            // steam_auth (правильный порядок событий). Для noauth (steam_auth не будет)
            // эмитим прямо здесь. ip берём с :port из BotInfo (а не сырой аргумент —
            // у реального игрока connection.ipaddress всегда ip:port).
            if (skipAuth && _bots.TryGetValue(steamId, out var biRcon))
                EmitPlayerConnectAnalytics(steamId, displayName, biRcon.IpAddress);

            arg.ReplyWith($"OK {steamId} {displayName}");
        }

        // Диагностика: после батч-register дёрнуть `rne.authstats` — покажет, на сколько
        // ботов Steam реально прислал OnValidateAuthTicketResponse (respOk), на скольких
        // отказал (respFail) и сколько ВИСЯТ без ответа (pending/missing). Если begun=20,
        // а respOk<20 — вот объяснение «20 зарегали, в playerCount 6»: player_connect
        // эмитится только на respOk-колбэке.
        [ConsoleCommand("rne.authstats")]
        private void CmdAuthStats(ConsoleSystem.Arg arg)
        {
            if (!arg.IsRcon && !arg.IsAdmin) { arg.ReplyWith("No permission"); return; }
            int missing = _steamAuthBegun - _steamAuthRespOk - _steamAuthRespFail;
            string outp = $"[STEAMAUTH] begun={_steamAuthBegun} respOk={_steamAuthRespOk} respFail={_steamAuthRespFail} pending={_steamAuthBeginAt.Count} missing={missing}\n";
            double now = TimeEx.realtimeSinceStartup;
            foreach (var kv in _steamAuthBeginAt)
                outp += $"  PENDING {kv.Key} waiting {(now - kv.Value):F1}s (no Steam callback yet)\n";
            arg.ReplyWith(outp);
            Log(outp);
        }

        // SpawnBotByConfig is the single entry point used by both the RCON admin.register
        // and the WS register_bot cmd. Delegates to CreateBot (sleeper).
        private BasePlayer SpawnBotByConfig(ulong steamId, string displayName, string ipAddress)
        {
            return CreateBot(steamId, displayName, ipAddress);
        }

        [ConsoleCommand("rne.unregister")]
        private void CmdUnregister(ConsoleSystem.Arg arg)
        {
            if (!arg.IsRcon && !arg.IsAdmin)
            {
                arg.ReplyWith("No permission");
                return;
            }

            if (!arg.HasArgs(1))
            {
                arg.ReplyWith("Usage: rne.unregister <steamId>");
                return;
            }

            if (!ulong.TryParse(arg.GetString(0), out ulong steamId))
            {
                arg.ReplyWith("Invalid steamId");
                return;
            }

            // Capture displayName ДО RemoveBot — RemoveBot чистит _bots, после него
            // BotInfo уже недоступна. Это явный unregister entry point — единственное
            // (вместе с WS-unregister handler ниже) место где мы эмиттим player_disconnect.
            // На death/respawn/timeout-cleanup RemoveBot тоже вызывается, но без этих
            // двух явных точек — поэтому фейкового disconnect'а не будет.
            string disconnectName = _bots.TryGetValue(steamId, out var botInfo) ? botInfo.DisplayName : null;
            bool removed = RemoveBot(steamId, reason: "rcon_unregister");
            if (removed && disconnectName != null)
                EmitPlayerDisconnectAnalytics(steamId, disconnectName, "Disconnected");

            arg.ReplyWith(removed ? $"OK {steamId}" : $"FAIL {steamId}");
        }

        [ConsoleCommand("rne.list")]
        private void CmdList(ConsoleSystem.Arg arg)
        {
            if (!arg.IsRcon && !arg.IsAdmin)
            {
                arg.ReplyWith("No permission");
                return;
            }

            if (_bots.Count == 0)
            {
                arg.ReplyWith("No bots");
                return;
            }

            var lines = new List<string>();
            foreach (var kvp in _bots)
            {
                var p = kvp.Value.Player;
                if (p == null || p.IsDestroyed) continue;
                var pos = p.transform.position;
                lines.Add($"{kvp.Key} | {p.displayName} | {pos.x:F0},{pos.y:F0},{pos.z:F0} | hp={p.health:F0} | sleeping");
            }
            arg.ReplyWith(string.Join("\n", lines));
        }

        [ConsoleCommand("rne.count")]
        private void CmdCount(ConsoleSystem.Arg arg)
        {
            if (!arg.IsRcon && !arg.IsAdmin)
            {
                arg.ReplyWith("No permission");
                return;
            }

            arg.ReplyWith($"{_bots.Count}");
        }

        // admin.recreate [<steamId>] — tear down and re-register one or all bots
        // reusing their cached DisplayName / IP / Steam ticket. Handy for iterating
        // on spawn/AI config without going through the controller Assign/Release
        // cycle every time.
        [ConsoleCommand("rne.recreate")]
        private void CmdRecreate(ConsoleSystem.Arg arg)
        {
            if (!arg.IsRcon && !arg.IsAdmin)
            {
                arg.ReplyWith("No permission");
                return;
            }

            // Snapshot everything we need BEFORE we start mutating _bots.
            var targets = new List<(ulong id, string name, string ip, string ticket, bool hasSession)>();
            if (arg.HasArgs(1))
            {
                if (!ulong.TryParse(arg.GetString(0), out ulong oneId))
                {
                    arg.ReplyWith("Usage: rne.recreate [<steamId>]");
                    return;
                }
                if (!_bots.TryGetValue(oneId, out var oneInfo))
                {
                    arg.ReplyWith($"Bot {oneId} not found");
                    return;
                }
                targets.Add((oneId, oneInfo.DisplayName, oneInfo.IpAddress, oneInfo.AuthTicketHex ?? "", oneInfo.HasSteamSession));
            }
            else
            {
                foreach (var kvp in _bots)
                {
                    var info = kvp.Value;
                    targets.Add((kvp.Key, info.DisplayName, info.IpAddress, info.AuthTicketHex ?? "", info.HasSteamSession));
                }
            }

            if (targets.Count == 0)
            {
                arg.ReplyWith("No bots to recreate");
                return;
            }

            int ok = 0, fail = 0;
            foreach (var t in targets)
            {
                try
                {
                    // Clear the HasSteamSession flag before RemoveBot so it does NOT
                    // call EndSteamSession — the Steam ticket handle stays valid and
                    // the new CustomPet re-registers against the same (still active)
                    // session via ValidateAuthTicketPrefix. Without this the second
                    // BeginSteamSession would fail with AuthTicketInvalidAlreadyUsed.
                    if (_bots.TryGetValue(t.id, out var liveInfo))
                        liveInfo.HasSteamSession = false;

                    RemoveBot(t.id, silent: true, preserveSteamSession: true);

                    var newPlayer = SpawnBotByConfig(t.id, t.name, t.ip);
                    if (newPlayer != null)
                    {
                        // Restore the cached session/ticket state. No re-BeginSteamSession
                        // needed — the original one is still alive and Steam's
                        // ValidateAuthTicketResponse will be replayed for the new entity.
                        _bots[t.id].HasSteamSession = t.hasSession;
                        _bots[t.id].AuthTicketHex = t.ticket;
                        ok++;
                    }
                    else
                    {
                        fail++;
                    }
                }
                catch (Exception ex)
                {
                    PrintWarning($"admin.recreate {t.id}: {ex.Message}");
                    fail++;
                }
            }

            arg.ReplyWith($"Recreated: {ok} ok, {fail} failed (total {targets.Count})");
        }

        [ConsoleCommand("rne.status")]
        private void CmdStatus(ConsoleSystem.Arg arg)
        {
            if (!arg.IsRcon && !arg.IsAdmin)
            {
                arg.ReplyWith("No permission");
                return;
            }

            var bots = new List<object>();
            foreach (var kvp in _bots)
            {
                var info = kvp.Value;
                var p = info.Player;
                bool alive = p != null && !p.IsDestroyed;
                bots.Add(new
                {
                    steam_id = kvp.Key.ToString(),
                    name = info.DisplayName,
                    ip = info.IpAddress,
                    steam_session = info.HasSteamSession,
                    alive,
                    health = alive ? p.health : 0f,
                    connected_seconds = alive
                        ? Math.Max(0, (int)(TimeEx.realtimeSinceStartup - info.OriginalConnectionTime)) : 0,
                    position = alive
                        ? $"{p.transform.position.x:F0},{p.transform.position.y:F0},{p.transform.position.z:F0}"
                        : ""
                });
            }

            arg.ReplyWith(JsonConvert.SerializeObject(new
            {
                bot_count = _bots.Count,
                server_players = BasePlayer.activePlayerList.Count,
                bots
            }));
        }

        // Single source of truth for "serverinfo" payload. Both plugin_init event and
        // the WebSocket hello frame serialize the same object, so every downstream
        // consumer (webhook handler, onWsHello, admin.serverinfo RCON) sees identical
        // fields including server_ip, game_port, query_port, rcon_port.
        private string GetServerInfoJson()
        {
            return JsonConvert.SerializeObject(BuildHelloPayload());
        }

        [ConsoleCommand("rne.serverinfo")]
        private void CmdServerInfo(ConsoleSystem.Arg arg)
        {
            if (!arg.IsRcon && !arg.IsAdmin)
            {
                arg.ReplyWith("No permission");
                return;
            }

            arg.ReplyWith(GetServerInfoJson());
        }

        [ConsoleCommand("rne.help")]
        private void CmdHelp(ConsoleSystem.Arg arg)
        {
            if (!arg.IsRcon && !arg.IsAdmin)
            {
                arg.ReplyWith("No permission");
                return;
            }

            var sb = new System.Text.StringBuilder();
            sb.AppendLine($"Admin Logger commands:");
            sb.AppendLine($"  rne.help                                         — this help");
            sb.AppendLine($"  rne.pair <pairKey> <wsUrl>                       — pair with controller");
            sb.AppendLine($"  rne.register <steamId> <name> <ip> <ticketHex>   — spawn a bot");
            sb.AppendLine($"  rne.unregister <steamId>                        — despawn a bot");
            sb.AppendLine($"  rne.list                                         — list all bots");
            sb.AppendLine($"  rne.count                                        — bot count");
            sb.AppendLine($"  rne.recreate [<steamId>]                         — recreate one or all bots");
            sb.AppendLine($"  rne.status                                       — plugin + bot status (JSON)");
            sb.AppendLine($"  rne.serverinfo                                   — server info JSON");
            sb.AppendLine($"  rne.debug                                        — toggle debug logs");
            sb.AppendLine($"  rne.update                                       — check + download plugin updates");
            sb.AppendLine($"");
            sb.AppendLine($"Current: paired={(!string.IsNullOrEmpty(_config.PairKey))}, bots={_bots.Count}, debug={_config.Debug}");
            arg.ReplyWith(sb.ToString());
        }

        [ConsoleCommand("rne.debug")]
        private void CmdDebug(ConsoleSystem.Arg arg)
        {
            if (!arg.IsRcon && !arg.IsAdmin)
            {
                arg.ReplyWith("No permission");
                return;
            }

            _config.Debug = !_config.Debug;
            SaveConfig();
            arg.ReplyWith($"Debug: {_config.Debug}");
        }

        [ConsoleCommand("rne.update")]
        private void CmdUpdate(ConsoleSystem.Arg arg)
        {
            if (!arg.IsRcon && !arg.IsAdmin)
            {
                arg.ReplyWith("No permission");
                return;
            }

            arg.ReplyWith("Checking for update...");
            // Oxide auto-reloads the .cs file after DownloadSingleFileUpdate writes it,
            // so no manual ReloadPlugin is needed — that would race with the async download.
            CheckForUpdate(applyUpdate: true);
        }

        #endregion

        #region AdminBot Entity

        private const string PrefabPetBot = "assets/rust.ai/agents/npcplayer/pet/frankensteinpet.prefab";
        private const string PrefabPlayer = "assets/prefabs/player/player.prefab";

        private class AdminBot : FrankensteinPet
        {
            public override void ServerInit()
            {
                base.ServerInit();
                // Cancel all NPC brain/thinking — bot just sleeps.
                // ServerThink_Internal became `internal` on NPCPlayer in the
                // Aug-2026 build — no longer visible from the plugin assembly.
                // The no-arg CancelInvoke() cancels every pending invoke on this
                // behaviour anyway (including NPCPlayer's InvokeRepeating of the
                // think method), so we don't need to name it explicitly; and
                // AIThinkManager.RemovePet covers the pet-think-manager path.
                CancelInvoke();
                try { AIThinkManager.RemovePet(this); } catch { }
            }

            // Protect from NullRef on fake connection when anything damages the bot
            public override void Hurt(HitInfo info)
            {
                try { base.Hurt(info); }
                catch (NullReferenceException) { }
            }

            public override BaseCorpse CreateCorpse(BasePlayer.PlayerFlags flagsOnDeath, Vector3 posOnDeath, Quaternion rotOnDeath, List<TriggerBase> triggersOnDeath, bool forceServerSide = false)
            {
                string prefab = "assets/prefabs/player/player_corpse_new.prefab";
                var corpse = DropCorpse(prefab, posOnDeath, rotOnDeath, flagsOnDeath, modelState) as PlayerCorpse;
                if (corpse != null)
                {
                    // BaseEntity.SetFlag was marked [Obsolete] in the Aug-2026 build and removed
                    // in the Sep-2026 build (25083359). Use the disposable flags scope exactly
                    // like FP's own BasePlayer.CreateCorpse does.
                    using (var flagsScope = corpse.StartSetFlags(BaseEntity.FlagsUpdateMode.SendNetworkUpdate))
                    {
                        flagsScope.Set(Flags.Reserved5, HasPlayerFlag(BasePlayer.PlayerFlags.DisplaySash));
                    }
                    corpse.TakeFrom(this, inventory.containerMain, inventory.containerWear, inventory.containerBelt);
                    corpse.playerName = displayName;
                    corpse.playerSteamID = userID;
                    corpse.Spawn();
                    corpse.TakeChildren(this);
                }
                return corpse;
            }
        }

        private static AdminBot CreateAdminBot(Vector3 position, Quaternion rotation)
        {
            // Create temp player + pet, copy fields, add our component
            var tempPlayer = GameManager.server.CreateEntity(PrefabPlayer, Vector3.zero, Quaternion.identity, false) as BasePlayer;
            var tempPet = GameManager.server.CreateEntity(PrefabPetBot, position, rotation, false) as FrankensteinPet;

            if (tempPlayer == null || tempPet == null)
            {
                if (tempPlayer != null) UnityEngine.Object.DestroyImmediate(tempPlayer, true);
                if (tempPet != null) UnityEngine.Object.DestroyImmediate(tempPet, true);
                return null;
            }

            var bot = tempPet.gameObject.AddComponent<AdminBot>();
            CopySerializableFields(tempPlayer, tempPet);
            CopySerializableFields(tempPet, bot);

            UnityEngine.Object.DestroyImmediate(tempPlayer, true);
            UnityEngine.Object.DestroyImmediate(tempPet, true);

            bot.enableSaving = false;
            return bot;
        }

        private static void CopySerializableFields<T>(T src, T dst)
        {
            if (src == null || dst == null) return;
            var fields = typeof(T).GetFields(BindingFlags.Public | BindingFlags.Instance);
            foreach (var field in fields)
            {
                try { field.SetValue(dst, field.GetValue(src)); }
                catch { }
            }
        }

        #endregion

        #region WebSocket Client

        // WsMessage — wire frame shared with the Go controller's wsmux package.
        // Keep field names in sync with bot/application/internal/wsmux/message.go.
        private class WsMessage
        {
            [JsonProperty("id", NullValueHandling = NullValueHandling.Ignore)]
            public long Id;
            [JsonProperty("type")]
            public string Type;
            [JsonProperty("name", NullValueHandling = NullValueHandling.Ignore)]
            public string Name;
            [JsonProperty("payload", NullValueHandling = NullValueHandling.Ignore)]
            public JToken Payload;
            [JsonProperty("replyTo", NullValueHandling = NullValueHandling.Ignore)]
            public long ReplyTo;
            [JsonProperty("ackId", NullValueHandling = NullValueHandling.Ignore)]
            public long AckId;
            [JsonProperty("ts", NullValueHandling = NullValueHandling.Ignore)]
            public long Ts;
        }

        private WsClient _ws;

        // WsClient — outbound WebSocket with persistent outbox, reconnect, and ack.
        //
        // Threading model:
        //   - ConnectAsync/ReceiveAsync/SendAsync live on .NET thread-pool (Task.Run).
        //   - Inbound handlers marshal state changes back to the Oxide main thread
        //     via Interface.Oxide.NextTick to avoid touching BasePlayer from non-main threads.
        //   - Outbox is serialized by a lock; DataFileSystem writes are on main thread.
        private class WsClient
        {
            private readonly AdminLogger _plugin;
            private ClientWebSocket _ws;
            private CancellationTokenSource _cts;
            private long _nextOutId;
            private long _lastSeenInId;
            private readonly object _lock = new object();
            private readonly SemaphoreSlim _sendGate = new SemaphoreSlim(1, 1);
            private readonly List<WsMessage> _outbox = new List<WsMessage>();
            private bool _running;
            private bool _connected;
            private int _reconnectAttempt;
            // Reference to the background task started in Start() so Stop()
            // can wait for it to drain. Without this, Carbon (and to a lesser
            // extent Oxide) reloads can race a still-receiving ReceiveAsync
            // with the new plugin instance, producing ObjectDisposedException
            // and outbox.json sharing-violation warnings.
            private Task _runLoopTask;

            public bool Connected { get { return _connected; } }

            public WsClient(AdminLogger plugin)
            {
                _plugin = plugin;
            }

            // LoadOutbox reads the persistent outbox file and recovers nextOutId.
            public void LoadOutbox()
            {
                // First-time migration: when running under Carbon, the data
                // dir shifts from oxide/data/ to carbon/data/. If a server
                // operator switches Oxide → Carbon and restarts, the legacy
                // outbox file would be silently abandoned; rescue it on the
                // first load.
                _plugin.MigrateLegacyOutboxIfNeeded();

                try
                {
                    var data = Interface.Oxide.DataFileSystem.ReadObject<List<WsMessage>>("AdminLogger/outbox");
                    if (data != null)
                    {
                        lock (_lock)
                        {
                            _outbox.Clear();
                            _outbox.AddRange(data);
                            foreach (var m in _outbox)
                            {
                                if (m.Id > _nextOutId) _nextOutId = m.Id;
                            }
                        }
                        _plugin.Log($"[WS] Outbox loaded: {_outbox.Count} unacked messages, nextOutId={_nextOutId}");
                    }
                }
                catch (Exception ex)
                {
                    _plugin.PrintWarning($"[WS] LoadOutbox failed: {ex.Message}");
                }
            }

            // Serialize file writes so concurrent SaveOutbox calls from the
            // main thread (Enqueue) and WS receive loop (HandleAck) don't
            // collide on the underlying file handle. Without this we see
            // "Sharing violation on path .../outbox.json".
            private readonly object _saveLock = new object();
            private void SaveOutbox()
            {
                List<WsMessage> copy;
                lock (_lock) { copy = new List<WsMessage>(_outbox); }
                lock (_saveLock)
                {
                    try
                    {
                        Interface.Oxide.DataFileSystem.WriteObject("AdminLogger/outbox", copy);
                    }
                    catch (Exception ex)
                    {
                        _plugin.PrintWarning($"[WS] SaveOutbox failed: {ex.Message}");
                    }
                }
            }

            // Start launches the connect/reconnect loop on a background task.
            public void Start()
            {
                if (_running) return;
                _running = true;
                _cts = new CancellationTokenSource();
                var startToken = _cts.Token;
                _runLoopTask = Task.Run(() => RunLoopAsync(startToken));
            }

            public void Stop()
            {
                _running = false;
                try { _cts?.Cancel(); } catch { }
                try { _ws?.Abort(); } catch { }
                _connected = false;

                // Wait briefly for RunLoopAsync to observe the cancel and exit.
                // We avoid Wait() with no timeout because the run loop holds an
                // outbound await on ReceiveAsync that may need a few hundred ms
                // to surface the cancellation. Carbon's reload is synchronous —
                // without this, the old task lives on and races the new
                // plugin instance for outbox.json access.
                try { _runLoopTask?.Wait(TimeSpan.FromSeconds(2)); } catch { }
                _runLoopTask = null;
            }

            // Enqueue adds an outbound event/cmd with a fresh id, persists the outbox,
            // and attempts to send immediately if connected.
            public long Enqueue(string type, string name, object payload)
            {
                var msg = new WsMessage
                {
                    Type = type,
                    Name = name,
                    Payload = payload != null ? JToken.FromObject(payload) : null,
                    Ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                };
                long id;
                lock (_lock)
                {
                    id = ++_nextOutId;
                    msg.Id = id;
                    _outbox.Add(msg);
                }
                SaveOutbox();
                _ = TrySendAsync(msg);
                return id;
            }

            private async Task TrySendAsync(WsMessage msg)
            {
                if (!_connected || _ws == null) return;
                try
                {
                    await SendRawAsync(msg);
                }
                catch (Exception ex)
                {
                    _plugin.Log($"[WS] Send failed (will be replayed on reconnect): {ex.Message}");
                }
            }

            private void HandleAck(long ackId)
            {
                bool changed;
                lock (_lock)
                {
                    int before = _outbox.Count;
                    _outbox.RemoveAll(m => m.Id == ackId);
                    changed = _outbox.Count != before;
                }
                if (changed) SaveOutbox();
            }

            private async Task RunLoopAsync(CancellationToken token)
            {
                while (_running && !token.IsCancellationRequested)
                {
                    var cfg = _plugin._config;
                    if (string.IsNullOrEmpty(cfg.WsUrl) || string.IsNullOrEmpty(cfg.PairKey))
                    {
                        try { await Task.Delay(5000, token); } catch { return; }
                        continue;
                    }

                    try
                    {
                        await ConnectAndServeAsync(cfg.WsUrl, cfg.PairKey, token);
                        _reconnectAttempt = 0;
                    }
                    catch (OperationCanceledException) { return; }
                    catch (Exception ex)
                    {
                        _plugin.Log($"[WS] connect/serve error: {ex.Message}");
                    }

                    _connected = false;
                    try { _ws?.Dispose(); } catch { }
                    _ws = null;

                    if (!_running || token.IsCancellationRequested) return;
                    _reconnectAttempt++;
                    int delay = Math.Min(60, (int)Math.Pow(2, Math.Min(_reconnectAttempt, 6)));
                    _plugin.Log($"[WS] reconnect in {delay}s (attempt #{_reconnectAttempt})");
                    try { await Task.Delay(TimeSpan.FromSeconds(delay), token); } catch { return; }
                }
            }

            private async Task ConnectAndServeAsync(string wsUrl, string pairKey, CancellationToken token)
            {
                _ws = new ClientWebSocket();
                _ws.Options.SetRequestHeader("Authorization", "Bearer " + pairKey);
                _ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);

                _plugin.Log($"[WS] connecting to {wsUrl} …");
                await _ws.ConnectAsync(new Uri(wsUrl), token);
                _plugin.Log($"[WS] connected, sending hello");

                // Send hello with server info.
                var helloPayload = _plugin.BuildHelloPayload();
                var hello = new WsMessage
                {
                    Type = "hello",
                    Payload = JToken.FromObject(helloPayload),
                    Ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                };
                await SendRawAsync(hello);

                _connected = true;

                // Replay outbox (everything still unacked from before).
                List<WsMessage> replay;
                lock (_lock) { replay = new List<WsMessage>(_outbox); }
                foreach (var m in replay)
                {
                    if (token.IsCancellationRequested) return;
                    try { await SendRawAsync(m); } catch { break; }
                }

                // Reader loop.
                var buf = new byte[16 * 1024];
                var sb = new StringBuilder();
                while (_ws.State == WebSocketState.Open && !token.IsCancellationRequested)
                {
                    sb.Clear();
                    WebSocketReceiveResult res;
                    do
                    {
                        res = await _ws.ReceiveAsync(new ArraySegment<byte>(buf), token);
                        if (res.MessageType == WebSocketMessageType.Close)
                        {
                            _plugin.Log("[WS] server closed connection");
                            return;
                        }
                        sb.Append(Encoding.UTF8.GetString(buf, 0, res.Count));
                    } while (!res.EndOfMessage);

                    try
                    {
                        var msg = JsonConvert.DeserializeObject<WsMessage>(sb.ToString());
                        if (msg != null) HandleInbound(msg);
                    }
                    catch (Exception ex)
                    {
                        _plugin.PrintWarning($"[WS] parse inbound failed: {ex.Message}");
                    }
                }
            }

            private async Task SendRawAsync(WsMessage msg)
            {
                var socket = _ws;
                var token = _cts.Token;
                await _sendGate.WaitAsync(token);
                try
                {
                    if (socket == null || socket != _ws || socket.State != WebSocketState.Open) return;
                    var json = JsonConvert.SerializeObject(msg);
                    var bytes = Encoding.UTF8.GetBytes(json);
                    await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, token);
                }
                finally { _sendGate.Release(); }
            }

            private void HandleInbound(WsMessage msg)
            {
                switch (msg.Type)
                {
                    case "hello_ack":
                        _plugin.Log("[WS] hello_ack received, paired");
                        break;

                    case "hb":
                        // ignored for now (controller echoes HB)
                        break;

                    case "ack":
                        if (msg.AckId > 0) HandleAck(msg.AckId);
                        break;

                    case "cmd":
                        // Dispatch to command handler on main thread.
                        var id = msg.Id;
                        var name = msg.Name;
                        var payload = msg.Payload;
                        Interface.Oxide.NextTick(() =>
                        {
                            object respPayload = null;
                            try
                            {
                                respPayload = _plugin.HandleWsCommand(name, payload);
                            }
                            catch (Exception ex)
                            {
                                respPayload = new { ok = false, error = ex.Message };
                            }
                            var resp = new WsMessage
                            {
                                Type = "resp",
                                ReplyTo = id,
                                Payload = respPayload != null ? JToken.FromObject(respPayload) : null,
                                Ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                            };
                            _ = TrySendAsync(resp);
                            // Also ACK the cmd so the controller removes it from its outbox.
                            var ack = new WsMessage { Type = "ack", AckId = id, Ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds() };
                            _ = TrySendAsync(ack);
                        });
                        break;
                }
            }

            // SendHeartbeat shoots a bare HB frame (not through the outbox).
            public void SendHeartbeat()
            {
                if (!_connected) return;
                var hb = new WsMessage { Type = "hb", Ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds() };
                _ = TrySendAsync(hb);
            }
        }

        // Cached protocol/version pulled from ConVar.Admin.ServerInfo() at first
        // access. Both fields are immutable for the lifetime of the process so
        // a single reflection call is enough; subsequent calls return the cache.
        private static int _cachedProtocolVersion = -1;
        private static string _cachedProtocolString;

        private static void EnsureProtocolCached()
        {
            if (_cachedProtocolVersion >= 0) return;
            _cachedProtocolVersion = 0;
            _cachedProtocolString = "";

            // Источник правды — `ConVar.Admin.ServerInfo()`. На живом сервере
            // через admin `serverinfo` команду подтверждено что эта функция
            // отдаёт `Version: 2625` и `Protocol: "2625.284.1"`. Вызываем
            // напрямую, без reflection.
            try
            {
                var info = ConVar.Admin.ServerInfo();
                _cachedProtocolVersion = info.Version;
                _cachedProtocolString = info.Protocol ?? "";
                if (_cachedProtocolVersion == 0)
                    _instance?.PrintWarning($"EnsureProtocolCached: ConVar.Admin.ServerInfo().Version=0 — серверный API вернул нули");
                return;
            }
            catch (Exception ex)
            {
                _instance?.PrintWarning($"EnsureProtocolCached: direct ConVar.Admin.ServerInfo() failed: {ex.Message} — fallback на reflection");
            }

            // Fallback: пробуем `Rust.Protocol` через reflection во всех загруженных
            // assemblies (иногда живёт не в BasePlayer.Assembly после ILRepack).
            try
            {
                foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                {
                    Type t = null;
                    try { t = asm.GetType("Rust.Protocol", throwOnError: false); } catch { continue; }
                    if (t == null) continue;

                    var networkF = t.GetField("network", BindingFlags.Public | BindingFlags.Static);
                    if (networkF != null)
                        try { _cachedProtocolVersion = Convert.ToInt32(networkF.GetValue(null)); } catch { }

                    var printableP = t.GetProperty("printable", BindingFlags.Public | BindingFlags.Static);
                    if (printableP != null)
                    {
                        var v = printableP.GetValue(null);
                        if (v != null) _cachedProtocolString = v.ToString();
                    }
                    else
                    {
                        var printableF = t.GetField("printable", BindingFlags.Public | BindingFlags.Static);
                        if (printableF != null)
                        {
                            var v = printableF.GetValue(null);
                            if (v != null) _cachedProtocolString = v.ToString();
                        }
                    }
                    if (_cachedProtocolVersion > 0) break;
                }

                if (_cachedProtocolVersion == 0)
                    _instance?.PrintWarning($"EnsureProtocolCached: ни ConVar.Admin.ServerInfo() ни Rust.Protocol не дали данных");
            }
            catch (Exception ex)
            {
                _instance?.PrintWarning($"EnsureProtocolCached fallback: {ex.Message}");
            }
        }

        private static int GetServerProtocolVersion()
        {
            EnsureProtocolCached();
            return _cachedProtocolVersion;
        }

        private static string GetServerProtocolString()
        {
            EnsureProtocolCached();
            return _cachedProtocolString ?? "";
        }

        // SaveCreatedTime updates on every world save (hourly), so it cannot be
        // cached like Version/Protocol. Reads the field fresh from
        // ConVar.Admin.ServerInfo() and converts the resulting DateTime to Unix
        // seconds (UTC). Returns 0 if the method/field is missing or the value
        // is unparseable — never throws.
        private static long GetServerSaveCreatedUnix()
        {
            try
            {
                var m = typeof(ConVar.Admin).GetMethod("ServerInfo",
                            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
                     ?? typeof(ConVar.Admin).GetMethod("serverinfo",
                            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
                if (m == null) return 0;
                var pars = m.GetParameters();
                var args = pars.Length == 0 ? null : new object[pars.Length];
                var result = m.Invoke(null, args);
                if (result == null) return 0;
                var t = result.GetType();
                var v = t.GetField("SaveCreatedTime", BindingFlags.Public | BindingFlags.Instance)?.GetValue(result)
                     ?? t.GetProperty("SaveCreatedTime", BindingFlags.Public | BindingFlags.Instance)?.GetValue(result);
                if (v == null) return 0;
                DateTime dt;
                if (v is DateTime parsed) dt = parsed;
                else if (!DateTime.TryParse(v.ToString(), out dt)) return 0;
                if (dt == default(DateTime)) return 0;
                var utc = dt.Kind == DateTimeKind.Utc ? dt : dt.ToUniversalTime();
                return (long)(utc - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds;
            }
            catch (Exception ex)
            {
                _instance?.PrintWarning($"GetServerSaveCreatedUnix: {ex.Message}");
                return 0;
            }
        }

        // GetEnvTime / GetEnvDayLength — текущее значение day-night convars.
        // env.time (0..24 in-game часов) и env.daylength (real minutes per
        // in-game day, обычно 60) нужны контроллеру для расчёта поля
        // `time_of_day` в client_performance analytics events. Реальный клиент
        // шлёт `time_of_day = (long)(env.time / 24.0 * 1e18)` — без серверного
        // env.time бот не сможет имитировать это поле, и FP backend режет нас
        // как fake-players (MITM 2026-05-29 подтвердил формат).
        private static float GetEnvTime()
        {
            try { return ConVar.Env.time; }
            catch { return 0f; }
        }
        // env.daylength convar НЕ существует в этой версии Rust (compile error
        // 2026-05-29). Day-night cycle на vanilla server идёт с дефолтом 60 real
        // minutes per in-game day. Если admin изменил через TOD_Sky компонент —
        // не reflect'нём, но 60 — достаточно близкое приближение для FP
        // time_of_day filter (drift накапливается на <1 час за 6 real-минут
        // период между env_tick событиями).
        private static float GetEnvDayLength()
        {
            return 60f;
        }

        // SafeMapFileName — map_filename ровно как его строит КЛИЕНТ в событии
        // world_prop_usage. ВАЖНО: серверный World.MapFileName тут НЕ подходит — на
        // загруженном procedural-сервере он идёт по ветке IsUploaded и отдаёт КОРОТКУЮ
        // форму (proceduralmap.<size>.<seed>.285.map), т.к. MapUploader.OriginalMapFileName
        // считается ДО установки World.Url (MapUploader.cs:56, до строки 59).
        // Клиент при заданном Url считает (World.cs Name + MapFileName, ветка URL):
        //   name = Path.GetFileNameWithoutExtension(Url);   // включает backend-хэш (wipeid)
        //   map_filename = name + "_" + Url.MurmurHashUnsigned() + ".map";  // ДЛИННАЯ форма
        // World.Url — URL, который бэкенд вернул на rust-map-upload (содержит хэш) и
        // который сервер раздаёт клиентам (ServerMgr: approval.levelUrl = World.Url).
        // MurmurHashUnsigned — public string-extension (Facepunch.UnityEngine, global ns).
        private static string SafeMapFileName()
        {
            try
            {
                string url = World.Url;
                if (!string.IsNullOrEmpty(url))
                {
                    // backend-URL без %-escape, поэтому UnEscapeURL не нужен; murmur —
                    // от СЫРОГО Url (как у клиента). При появлении escape — добавить
                    // System.Uri.UnescapeDataString вокруг name.
                    string name = System.IO.Path.GetFileNameWithoutExtension(url);
                    return name + "_" + url.MurmurHashUnsigned() + ".map";
                }
                // Url пуст (карта не загружена / не procedural) → клиент тоже получит
                // короткую форму; вернём серверный World.MapFileName.
                return World.MapFileName ?? "";
            }
            catch { return ""; }
        }

        // BuildHelloPayload mirrors GetServerInfoJson() but returns an object
        // for direct JSON serialization inside the hello frame.
        // BEGIN AUTOMATIC WORLD METADATA
        private string _worldMetadataKey;
        private double _worldMetadataNextCheck;
        private string[] _requiredWorldProps;
        private string _worldMetadataStatus = "waiting_world";

        private static object ReadWorldMember(object source, string name)
        {
            if (source == null) return null;
            var type = source as Type ?? source.GetType();
            var flags = BindingFlags.Public | BindingFlags.NonPublic
                | (source is Type ? BindingFlags.Static : BindingFlags.Instance);
            var property = type.GetProperty(name, flags);
            if (property != null && property.GetIndexParameters().Length == 0)
                return property.GetValue(source is Type ? null : source, null);
            return type.GetField(name, flags)?.GetValue(source is Type ? null : source);
        }

        private static Type FindWorldType(string name)
        {
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                var type = assembly.GetType(name, false) ?? assembly.GetType("Facepunch." + name, false);
                if (type != null) return type;
            }
            return null;
        }

        private static string GetWorldTimestamp()
        {
            try
            {
                var value = ReadWorldMember(typeof(World), "Timestamp");
                return Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture)
                    .ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
            catch { return "0"; }
        }

        private void RefreshWorldMetadata()
        {
            string key = SafeMapFileName() + "|" + GetWorldTimestamp() + "|" + (World.Url ?? "");
            if (_worldMetadataKey == key && TimeEx.realtimeSinceStartup < _worldMetadataNextCheck) return;
            if (_worldMetadataKey != key) _requiredWorldProps = null;
            _worldMetadataKey = key;
            _worldMetadataNextCheck = TimeEx.realtimeSinceStartup + 30d;
            string status = "unavailable";
            try
            {
                var serialization = ReadWorldMember(typeof(World), "Serialization");
                var data = ReadWorldMember(serialization, "world");
                var prefabs = ReadWorldMember(data, "prefabs") as System.Collections.IEnumerable;
                if (prefabs == null || string.IsNullOrEmpty(SafeMapFileName()))
                    status = "waiting_world";
                else
                {
                    var backend = ReadWorldMember(FindWorldType("FileSystem"), "Backend");
                    var poolType = FindWorldType("StringPool");
                    var getPath = poolType?.GetMethod("Get", BindingFlags.Public | BindingFlags.Static,
                        null, new[] { typeof(uint) }, null);
                    MethodInfo getScenes = null;
                    if (backend != null)
                        foreach (var method in backend.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance))
                            if (method.Name == "GetRequiredAssetScenesForPrefabs" && method.GetParameters().Length == 1)
                            { getScenes = method; break; }
                    if (getPath != null && getScenes != null)
                    {
                        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                        int prefabCount = 0;
                        foreach (var prefab in prefabs)
                        {
                            if (++prefabCount > 1000000) throw new InvalidOperationException("Map prefab limit exceeded");
                            var id = Convert.ToUInt32(ReadWorldMember(prefab, "id"), System.Globalization.CultureInfo.InvariantCulture);
                            var path = getPath.Invoke(null, new object[] { id }) as string;
                            if (string.IsNullOrEmpty(path)) throw new InvalidOperationException("Map prefab path unavailable");
                            paths.Add(path);
                        }
                        // Matches World.Spawn: query dependencies, take the two props
                        // scenes, lower-case and sort. Never load scenes or fabricate [].
                        var scenes = getScenes.Invoke(backend, new object[] { paths }) as System.Collections.IDictionary;
                        if (scenes == null) throw new InvalidOperationException("Map asset scenes unavailable");
                        var props = new List<string>();
                        foreach (var scene in new[] { "AssetScene-props.common", "AssetScene-props.other" })
                        {
                            if (!scenes.Contains(scene)) continue;
                            var values = scenes[scene] as System.Collections.IEnumerable;
                            if (values == null) throw new InvalidOperationException("Invalid map asset scene");
                            foreach (var value in values)
                            {
                                var prop = value as string;
                                if (prop == null || prop.Length > 1024 || props.Count >= 4096)
                                    throw new InvalidOperationException("Map props limit exceeded");
                                props.Add(prop.ToLowerInvariant());
                            }
                        }
                        props.Sort(StringComparer.Ordinal);
                        if (Encoding.UTF8.GetByteCount(JsonConvert.SerializeObject(props)) > 64 * 1024)
                            throw new InvalidOperationException("Map props payload limit exceeded");
                        _requiredWorldProps = props.ToArray();
                        _worldMetadataNextCheck = TimeEx.realtimeSinceStartup + 300d;
                        status = "ready";
                    }
                }
            }
            catch { _requiredWorldProps = null; status = "unavailable"; }
            if (status != "ready") _requiredWorldProps = null;
            if (_worldMetadataStatus != status && status == "unavailable")
                PrintWarning("Automatic map metadata is unavailable in this server build; will retry automatically.");
            _worldMetadataStatus = status;
        }
        // END AUTOMATIC WORLD METADATA

        private object BuildHelloPayload()
        {
            string mapFilename = SafeMapFileName();
            string worldTimestamp = GetWorldTimestamp();
            string mapUrl = World.Url ?? "";
            bool cachedMapMatches = _worldMetadataKey == mapFilename + "|" + worldTimestamp + "|" + mapUrl;
            string serverSteamId = "0";
            try { serverSteamId = SteamServer.SteamId.ToString(); } catch { }
            string assemblyHash = "unknown";
            try
            {
                if (SingletonComponent<ServerMgr>.Instance != null)
                {
                    var prop = typeof(ServerMgr).GetProperty("AssemblyHash",
                        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                    if (prop != null)
                        assemblyHash = (string)prop.GetValue(ServerMgr.Instance) ?? "unknown";
                }
            }
            catch { }

            string changeset = "unknown", branch = "release", buildDate = "unknown";
            try
            {
                var b = BuildInfo.Current;
                if (b != null)
                {
                    if (b.Scm != null)
                    {
                        changeset = b.Scm.ChangeId ?? "unknown";
                        branch = b.Scm.Branch ?? "release";
                    }
                    buildDate = b.BuildDate.ToString("o");
                }
            }
            catch { }

            // Network-facing addresses. ConVar.Server.ip is what the server binds to;
            // for hosts behind NAT this can be 0.0.0.0. The controller knows the server's
            // public IP from the WS upgrade remoteAddr, so an empty/0.0.0.0 here is fine.
            string serverIp = "";
            int gamePort = 0, queryPort = 0, rconPort = 0;
            try
            {
                serverIp = ConVar.Server.ip ?? "";
                gamePort = ConVar.Server.port;
                queryPort = ConVar.Server.queryport;
            }
            catch { }
            // RCON port lives in ConVar.Server.rcon.port (the "rcon" subtree) or in a
            // separate ConVar.Server.RconPort static — naming varies between builds.
            // Try a few well-known paths via reflection to stay compatible.
            try
            {
                var asm = typeof(BasePlayer).Assembly;
                foreach (var typeName in new[] { "ConVar.Server", "ConVar.RCon", "RCon" })
                {
                    var t = asm.GetType(typeName);
                    if (t == null) continue;
                    foreach (var fieldName in new[] { "rconport", "rcon_port", "RconPort", "Port" })
                    {
                        var fi = t.GetField(fieldName, BindingFlags.Public | BindingFlags.Static);
                        if (fi != null)
                        {
                            try { rconPort = Convert.ToInt32(fi.GetValue(null)); } catch { }
                            if (rconPort > 0) break;
                        }
                        var pi = t.GetProperty(fieldName, BindingFlags.Public | BindingFlags.Static);
                        if (pi != null)
                        {
                            try { rconPort = Convert.ToInt32(pi.GetValue(null)); } catch { }
                            if (rconPort > 0) break;
                        }
                    }
                    if (rconPort > 0) break;
                }
            }
            catch { }

            return new
            {
                server_steam_id = serverSteamId,
                companion_app_id = ConVar.App.serverid,
                api_key = "",
                protocol = GetServerProtocolVersion(),
                protocol_string = GetServerProtocolString(),
                changeset,
                branch,
                build_date = buildDate,
                assembly_hash = assemblyHash,
                unity = UnityEngine.Application.unityVersion,
                world_size = ConVar.Server.worldsize,
                world_seed = ConVar.Server.seed,
                world_ts = worldTimestamp,
                env_time = GetEnvTime(),
                env_daylength = GetEnvDayLength(),
                level_url = ConVar.Server.levelurl,
                map = ConVar.Server.level,
                map_filename = mapFilename,
                map_url = mapUrl,
                required_props = cachedMapMatches ? _requiredWorldProps : null,
                world_metadata_status = cachedMapMatches ? _worldMetadataStatus : "waiting_world",
                plugin_version = "2.5.9",
                hostname = ConVar.Server.hostname,
                max_players = ConVar.Server.maxplayers,
                server_ip = serverIp,
                game_port = gamePort,
                query_port = queryPort,
                rcon_port = rconPort,
                last_seen_seq_in = 0L,
            };
        }

        // HandleWsCommand dispatches inbound WS commands to existing bot ops.
        // Runs on the Oxide main thread.
        private object HandleWsCommand(string name, JToken payload)
        {
            Log($"[WS cmd] {name}"); // Never log incoming auth ticket payloads.
            switch (name)
            {
                case "ping":
                    return new { ok = true };

                case "reconcile":
                    {
                        RefreshWorldMetadata();
                        var bots = new List<object>();
                        foreach (var kvp in _bots)
                        {
                            var p = kvp.Value.Player;
                            bool alive = p != null && !p.IsDestroyed;
                            bots.Add(new
                            {
                                steam_id = kvp.Key.ToString(),
                                name = kvp.Value.DisplayName,
                                ip = kvp.Value.IpAddress,
                                alive,
                                health = alive ? p.health : 0f,
                                has_steam_session = kvp.Value.HasSteamSession,
                            });
                        }
                        return new { ok = true, bots, server_info = BuildHelloPayload() };
                    }

                case "register_bot":
                    {
                        var steamId = ParseSteamId(payload);
                        var displayName = payload?["name"]?.Value<string>() ?? "";
                        var ipAddress = payload?["ip"]?.Value<string>() ?? "0.0.0.0";
                        var ticketHex = payload?["ticket_hex"]?.Value<string>() ?? "";
                        var skipAuth = payload?["noauth"]?.Value<bool>() ?? false;

                        if (steamId < 10000000UL)
                            return new { ok = false, error = "invalid steamId" };

                        // Idempotent re-register: см. комментарий в CmdRegister.
                        // Балансируем analytics lifecycle: для зомби сначала disconnect.
                        if (_bots.TryGetValue(steamId, out var wsZombie))
                        {
                            EmitPlayerDisconnectAnalytics(steamId, wsZombie.DisplayName, "Disconnected");
                            RemoveBot(steamId, silent: true, reason: "ws_replace_entity");
                        }

                        if (!skipAuth && !BeginSteamSession(steamId, ticketHex, payload?["auth_attempt_id"]?.Value<string>()))
                            return new { ok = false, error = "steam_auth_failed" };

                        var player = SpawnBotByConfig(steamId, displayName, ipAddress);
                        if (player == null)
                        {
                            if (!skipAuth) EndSteamSession(steamId, "ws_spawn_failed");
                            return new { ok = false, error = "create_failed" };
                        }
                        _bots[steamId].HasSteamSession = !skipAuth;
                        _bots[steamId].AuthTicketHex = ticketHex;
                        // auth-путь: player_connect эмитится из ValidateAuthTicketPrefix
                        // ПОСЛЕ steam_auth. noauth: эмитим здесь. ip с :port из BotInfo.
                        if (skipAuth)
                            EmitPlayerConnectAnalytics(steamId, displayName, _bots[steamId].IpAddress);
                        return new { ok = true, pos = $"{player.transform.position.x:F0},{player.transform.position.y:F0},{player.transform.position.z:F0}" };
                    }

                case "unregister_bot":
                    {
                        var steamId = ParseSteamId(payload);
                        if (steamId == 0) return new { ok = false, error = "invalid steamId" };
                        // Capture displayName ДО RemoveBot — нужно для player_disconnect emit.
                        string wsDiscName = _bots.TryGetValue(steamId, out var wsBotInfo) ? wsBotInfo.DisplayName : null;
                        bool wsOk = RemoveBot(steamId, reason: AuthReason(payload?["reason"]?.Value<string>() ?? "ws_unregister"));
                        if (wsOk && wsDiscName != null)
                            EmitPlayerDisconnectAnalytics(steamId, wsDiscName, "Disconnected");
                        return new { ok = wsOk };
                    }

                case "refresh_ticket":
                    {
                        var steamId = ParseSteamId(payload);
                        var ticketHex = payload?["ticket_hex"]?.Value<string>() ?? "";
                        if (steamId == 0) return new { ok = false, error = "invalid steamId" };
                        if (!_bots.ContainsKey(steamId)) return new { ok = false, error = "unknown bot" };
                        EndSteamSession(steamId, "ws_refresh_ticket");
                        _bots[steamId].HasSteamSession = false;
                        bool refreshed = BeginSteamSession(steamId, ticketHex, payload?["auth_attempt_id"]?.Value<string>());
                        if (refreshed) _bots[steamId].AuthTicketHex = ticketHex;
                        return new { ok = refreshed };
                    }
            }
            return new { ok = false, error = "unknown cmd: " + name };
        }

        // ParseSteamId accepts the payload["steam_id"] field whether it arrives as
        // a JSON number (from typed Go payloads) or as a decimal string (from
        // wsCommander translating legacy RCON admin.* commands, which always uses
        // strconv.FormatUint). Newtonsoft's Value<ulong>() on a string token
        // returns 0 instead of parsing — so we handle the string case explicitly.
        private static ulong ParseSteamId(JToken payload)
        {
            var t = payload?["steam_id"];
            if (t == null) return 0UL;
            if (t.Type == JTokenType.Integer) return t.Value<ulong>();
            if (t.Type == JTokenType.String)
            {
                return ulong.TryParse(t.Value<string>(), out var id) ? id : 0UL;
            }
            return 0UL;
        }

        // EmitEnvTick шлёт текущие server-side env.time / env.daylength в
        // контроллер. Контроллер хранит последнее значение + момент приёма;
        // в analytics flush'е пересчитывает env.time на момент flush'а как
        //   env.time_now = (env.time_at_tick + elapsed_sec * 24 / (daylength*60)) mod 24
        // и эмитит analytics поле time_of_day = (long)(env.time_now/24*1e18),
        // совпадая с форматом реального клиента (MITM 2026-05-29 декодирован).
        // steamId=0 — server-wide event (паттерн как у "plugin_init").
        private void EmitEnvTick()
        {
            try
            {
                if (_ws == null || string.IsNullOrEmpty(_config.WsUrl) || string.IsNullOrEmpty(_config.PairKey))
                    return; // не paired — нет смысла слать
                var envTime = GetEnvTime();
                var envDay  = GetEnvDayLength();
                // detail — JSON-строка, контроллер парсит её отдельным path'ом.
                // Numeric serializer с InvariantCulture: иначе на ru-RU обоях
                // получим "12,4" вместо "12.4".
                var detail = string.Format(
                    System.Globalization.CultureInfo.InvariantCulture,
                    "{{\"env_time\":{0:0.######},\"env_daylength\":{1:0.######}}}",
                    envTime, envDay);
                SendEvent(0UL, "env_tick", detail);
            }
            catch (Exception ex) { PrintWarning($"EmitEnvTick: {ex.Message}"); }
        }

        // SendEvent is the new, reliable path for plugin → controller events.
        // Writes to the WS outbox (persistent, acked). Also dual-writes to the
        // legacy HTTP webhook for the rollout period — remove once WS is stable.
        private void SendEvent(ulong steamId, string eventType, string detail = "")
        {
            var payload = new
            {
                steam_id = steamId.ToString(),
                @event = eventType,
                detail,
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            };

            if (_ws == null || string.IsNullOrEmpty(_config.WsUrl) || string.IsNullOrEmpty(_config.PairKey))
            {
                Log($"SendEvent dropped ({eventType} {steamId}): not paired to controller");
                return;
            }
            try { _ws.Enqueue("event", eventType, payload); }
            catch (Exception ex) { PrintWarning($"[WS] enqueue failed: {ex.Message}"); }
        }

        [ConsoleCommand("rne.pair")]
        private void CmdPair(ConsoleSystem.Arg arg)
        {
            if (!arg.IsRcon && !arg.IsAdmin)
            {
                arg.ReplyWith("No permission");
                return;
            }
            if (!arg.HasArgs(2))
            {
                arg.ReplyWith("Usage: rne.pair <pairKey> <wsUrl>");
                return;
            }
            var key = arg.GetString(0);
            var url = arg.GetString(1);

            _config.PairKey = key;
            _config.WsUrl = url;

            // ControllerUrl нужен для /api/plugin/{hash,download}. Раньше его
            // приходилось править вручную; теперь выводим из wsUrl:
            //   wss://host[:port]/ws → https://host[:port]
            //   ws://host[:port]/ws  → http://host[:port]
            // Если парс не удался — оставляем старое значение.
            try
            {
                var u = new Uri(url);
                var scheme = u.Scheme == "wss" ? "https" : "http";
                _config.ControllerUrl = $"{scheme}://{u.Authority}";
            }
            catch { /* keep existing ControllerUrl */ }

            SaveConfig();

            if (_ws == null)
            {
                _ws = new WsClient(this);
                _ws.LoadOutbox();
            }
            else
            {
                _ws.Stop();
            }
            _ws.Start();

            arg.ReplyWith($"OK pairing → {url} (check logs)");
        }

        #endregion
    }
}
