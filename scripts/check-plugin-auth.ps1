#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'plugin/AdminLogger.cs'
$source = [IO.File]::ReadAllText($sourcePath)
$traceStart = $source.IndexOf('        private class AuthTrace')
$traceEnd = $source.IndexOf('        private static AdminLogger _instance;', $traceStart)
$helperStart = $source.IndexOf('        private static string AuthReason')
$helperEnd = $source.IndexOf('        // Эмиттит server.player_connect', $helperStart)
if ($traceStart -lt 0 -or $traceEnd -le $traceStart -or $helperStart -lt 0 -or $helperEnd -le $helperStart) { throw 'Helper extraction failed.' }
$traces = $source.Substring($traceStart, $traceEnd - $traceStart)
$helpers = $source.Substring($helperStart, $helperEnd - $helperStart)
$harness = @'
using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
public static class SteamServer {
    public static bool Accepted = true;
    public static bool FailEnd = false;
    public static bool BeginAuthSession(byte[] bytes, ulong id) { return Accepted; }
    public static void EndSession(ulong id) { if (FailEnd) throw new Exception("synthetic"); }
}
public static class TimeEx { public static double realtimeSinceStartup = 1.25; }
public class AuthHarness {
    private int _steamAuthBegun = 0, _steamAuthRespOk = 0, _steamAuthRespFail = 0;
    private Dictionary<ulong,double> _steamAuthBeginAt = new Dictionary<ulong,double>();
    private List<string> records = new List<string>();
    private bool failOutput = false;
    private void Puts(string value) { if(failOutput) throw new Exception("logging failed"); }
    private void PrintWarning(string value) {}
    private void Log(string value) {}
    private void SendEvent(ulong id, string name, string detail) { records.Add(detail); }
    private byte[] HexToBytes(string value) { return Convert.FromHexString(value); }
    TRACE_BODY
    HELPER_BODY
    private static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
    public static string Check() {
        var h = new AuthHarness();
        var id = "11111111-1111-4111-8111-111111111111";
        Assert(h.BeginSteamSession(76561198000000001UL, "010203", id), "begin result");
        var first = JObject.Parse(h.records[0]);
        Assert((string)first["attemptId"] == id, "attempt ID");
        Assert((string)first["ticketFingerprint"] == "039058c6f2c0cb492c533b0a", "SHA256 prefix");
        Assert((string)JObject.Parse(h.records[1])["operation"] == "begin_result", "begin sequence");
        h.EndSteamSession(76561198000000001UL, "assignment_stopped");
        Assert((string)JObject.Parse(h.records[3])["reason"] == "assignment_stopped", "end origin");
        h.AuthAudit(76561198000000001UL, "validate_callback", response: "AuthTicketCanceled");
        Assert((string)JObject.Parse(h.records[4])["association"] == "current_attempt_unverified", "callback ambiguity");
        SteamServer.FailEnd = true;
        h.EndSteamSession(76561198000000001UL, "private reason");
        var failed = JObject.Parse(h.records[6]);
        Assert((string)failed["operation"] == "end_error", "end failure audit");
        Assert((string)failed["reason"] == "unspecified", "reason allowlist");
        h.failOutput = true;
        Assert(h.BeginSteamSession(76561198000000001UL, "010203", id), "diagnostics isolated from authentication");
        h.failOutput = false; SteamServer.Accepted = false;
        Assert(!h.BeginSteamSession(76561198000000001UL, "010203"), "rejected begin");
        return "Actual plugin auth helpers compiled; fingerprint, attempt ID, end origin, callback ambiguity, errors and writer isolation passed.";
    }
}
'@
$harness = $harness.Replace('TRACE_BODY', $traces).Replace('HELPER_BODY', $helpers)
$references = @((Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter '*.dll').FullName) + @([Newtonsoft.Json.JsonConvert].Assembly.Location)
Add-Type -TypeDefinition $harness -ReferencedAssemblies $references -CompilerOptions '/nowarn:1701'
[AuthHarness]::Check()
