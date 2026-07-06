export type ServiceCallResult = {
  error: boolean;
  exception?: string;
  message?: string;
  debuginfo?: string;
  data?: unknown;
};

export type ClientConfig = {
  baseUrl: string;
  sesskey?: string;
  cookies?: string;
};

export class VirtualeClient {
  private readonly config: ClientConfig;

  constructor(config: ClientConfig) {
    this.config = config;
  }

  async callService(methodname: string, args: Record<string, unknown>): Promise<ServiceCallResult> {
    if (!this.config.sesskey) {
      throw new Error(`Missing sesskey for authenticated method ${methodname}`);
    }

    const endpoint = new URL("/lib/ajax/service.php", this.config.baseUrl);
    endpoint.searchParams.set("sesskey", this.config.sesskey);
    endpoint.searchParams.set("info", methodname);

    const body = [
      {
        index: 0,
        methodname,
        args
      }
    ];

    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (this.config.cookies) {
      headers.Cookie = this.config.cookies;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while calling ${methodname}`);
    }

    const json = (await response.json()) as unknown;
    if (!Array.isArray(json) || json.length === 0) {
      throw new Error(`Unexpected response shape from ${methodname}`);
    }

    return json[0] as ServiceCallResult;
  }

  async callNoLogin(methodname: string, args: Record<string, unknown>): Promise<unknown> {
    const endpoint = new URL("/lib/ajax/service-nologin.php", this.config.baseUrl);
    endpoint.searchParams.set("info", methodname);
    endpoint.searchParams.set("cachekey", "0");
    endpoint.searchParams.set(
      "args",
      JSON.stringify([
        {
          index: 0,
          methodname,
          args
        }
      ])
    );

    const headers: Record<string, string> = {};
    if (this.config.cookies) {
      headers.Cookie = this.config.cookies;
    }

    const response = await fetch(endpoint, {
      headers
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while calling nologin ${methodname}`);
    }

    return response.json();
  }
}
