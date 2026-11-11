import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('actual plugin map reader compiles and handles native scenes, map changes, unsupported builds and automatic recovery', t => {
  const sdks = spawnSync('dotnet', ['--list-sdks'], { encoding: 'utf8', windowsHide: true });
  const majors = [...(sdks.stdout || '').matchAll(/^(\d+)\.\d+\.\d+/gm)].map(match => Number(match[1])).filter(major => major >= 8);
  if (sdks.status !== 0 || !majors.length) { t.skip('Install .NET SDK 8+ to run the optional plugin helper check.'); return; }
  const directory = mkdtempSync(join(tmpdir(), 'controller-map-reader-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = readFileSync(new URL('../plugin/AdminLogger.cs', import.meta.url), 'utf8');
  const helper = source.split('// BEGIN AUTOMATIC WORLD METADATA')[1]?.split('// END AUTOMATIC WORLD METADATA')[0];
  assert.ok(helper);
  writeFileSync(join(directory, 'Reader.cs'), `using System; using System.Collections.Generic; using System.Reflection; using System.Text; using Newtonsoft.Json; public partial class MetadataHarness { ${helper} }`);
  writeFileSync(join(directory, 'Harness.cs'), readFileSync(new URL('./fixtures/WorldMetadataHarness.cs', import.meta.url)));
  writeFileSync(join(directory, 'Reader.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net${Math.max(...majors)}.0</TargetFramework></PropertyGroup><ItemGroup><Reference Include="Newtonsoft.Json"><HintPath>$(MSBuildSDKsPath)/../Newtonsoft.Json.dll</HintPath></Reference></ItemGroup></Project>`);
  writeFileSync(join(directory, 'NuGet.Config'), '<configuration><packageSources><clear /></packageSources></configuration>');
  const result = spawnSync('dotnet', ['run', '--project', join(directory, 'Reader.csproj'), '--verbosity', 'quiet'], {
    cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 45000,
    env: { ...process.env, DOTNET_CLI_HOME: directory, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /World metadata checks passed: 12/);
});
