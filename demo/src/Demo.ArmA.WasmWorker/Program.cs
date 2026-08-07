using Demo.ArmA.WasmWorker;
using Demo.ArmA.WasmWorker.Engine;
using Demo.Shared;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

// The one line that selects the topology. Nothing above IQueryEngine changes
// between the three arms — that is the architectural claim being demonstrated.
builder.Services.AddSingleton<IQueryEngine, DuckDbWasmEngine>();

await builder.Build().RunAsync();
