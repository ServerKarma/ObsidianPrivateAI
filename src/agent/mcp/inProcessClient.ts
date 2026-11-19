import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

/** Connects an MCP client to a server in the same process, with no network hop. */
export async function connectInProcess(server: Server, clientName = 'pi-agent'): Promise<Client> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: clientName, version: '1.0.0' });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}
