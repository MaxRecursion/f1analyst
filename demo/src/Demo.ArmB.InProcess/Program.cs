using Demo.ArmB.InProcess;
using Demo.ArmB.InProcess.Engine;
using Demo.Shared;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

InProcessDuckDbEngine.Navigation = builder.HostEnvironment.BaseAddress;
builder.Services.AddSingleton<IQueryEngine, InProcessDuckDbEngine>();

await builder.Build().RunAsync();
