using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using Newtonsoft.Json;

public static class World
{
    public static long Timestamp { get; set; } = 1793095186410;
    public static string Url { get; set; } = "https://maps.example/first.map";
    public static string MapFileName { get; set; } = "first.map";
    public static WorldSerialization Serialization { get; set; } = new WorldSerialization();
}
public class WorldSerialization { public WorldData world = new WorldData(); }
public class WorldData { public List<PrefabData> prefabs = new List<PrefabData> { new PrefabData { id = 1 }, new PrefabData { id = 2 }, new PrefabData { id = 1 } }; }
public class PrefabData { public uint id; }
public static class TimeEx { public static double realtimeSinceStartup; }
public static class FileSystem { public static object Backend = new TestBackend(); }
public static class StringPool { public static string Get(uint id) { return "assets/prefab/" + id; } }
public class TestBackend
{
    public int Calls;
    public int PathCount;
    public Hashtable Scenes = new Hashtable {
        { "AssetScene-props.common", new[] { "PROPS/Z", "Props/A" } },
        { "AssetScene-props.other", new[] { "Props/M" } },
        { "AssetScene-unrelated", new[] { "Ignore" } },
    };
    public IDictionary GetRequiredAssetScenesForPrefabs(HashSet<string> paths)
    { Calls++; PathCount = paths.Count; return Scenes; }
}
public partial class MetadataHarness
{
    private static string SafeMapFileName() { return World.MapFileName; }
    private void PrintWarning(string value) { }
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    public static void Main()
    {
        var harness = new MetadataHarness();
        var backend = (TestBackend)FileSystem.Backend;
        harness.RefreshWorldMetadata();
        Check(harness._worldMetadataStatus == "ready", "live metadata ready");
        Check(string.Join(",", harness._requiredWorldProps) == "props/a,props/m,props/z", "native scene filtering and sorting");
        Check(backend.PathCount == 2, "prefab paths deduplicated");
        harness.RefreshWorldMetadata();
        Check(backend.Calls == 1, "map cache avoids repeated scans");
        World.Timestamp++;
        backend.Scenes.Clear();
        harness.RefreshWorldMetadata();
        Check(harness._requiredWorldProps.Length == 0 && backend.Calls == 2, "new map invalidates cache and real empty list is preserved");
        TimeEx.realtimeSinceStartup = 301;
        FileSystem.Backend = null;
        harness.RefreshWorldMetadata();
        Check(harness._worldMetadataStatus == "unavailable" && harness._requiredWorldProps == null, "unsupported backend never fabricates an empty list");
        FileSystem.Backend = backend;
        TimeEx.realtimeSinceStartup = 332;
        harness.RefreshWorldMetadata();
        Check(harness._worldMetadataStatus == "ready", "automatic retry recovers");
        Check(GetWorldTimestamp() == "1793095186411", "world timestamp retains milliseconds");
        World.Serialization = null;
        World.Timestamp++;
        harness.RefreshWorldMetadata();
        Check(harness._worldMetadataStatus == "waiting_world" && harness._requiredWorldProps == null, "world not loaded is explicit");
        World.Serialization = new WorldSerialization();
        World.Timestamp++;
        backend.Scenes["AssetScene-props.common"] = new string[4097];
        harness.RefreshWorldMetadata();
        Check(harness._worldMetadataStatus == "unavailable" && harness._requiredWorldProps == null, "invalid props stay bounded");
        backend.Scenes.Clear();
        TimeEx.realtimeSinceStartup = 16777216.125d;
        World.Timestamp++;
        harness.RefreshWorldMetadata();
        int calls = backend.Calls;
        TimeEx.realtimeSinceStartup += 299.875d;
        harness.RefreshWorldMetadata();
        Check(backend.Calls == calls, "double precision expiry does not round down at long uptime");
        TimeEx.realtimeSinceStartup += 0.125d;
        harness.RefreshWorldMetadata();
        Check(backend.Calls == calls + 1, "refresh occurs exactly at double precision expiry");
        Console.WriteLine("World metadata checks passed: 12");
    }
}
