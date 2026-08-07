using Demo.ArmC.Host;
using Demo.ArmC.Host.Engine;
using Demo.Shared;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");
builder.Services.AddSingleton<IQueryEngine, WorkerHostedEngine>();
await builder.Build().RunAsync();
