import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

describe('Yjs CRDT Convergence and Invariant Engine Tests', () => {
  it('converges two independent Y.Docs editing concurrently to equivalent text content', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const textA = docA.getText('content');
    const textB = docB.getText('content');

    // Initial baseline sync
    const initialSync = Y.encodeStateAsUpdate(docA);
    Y.applyUpdate(docB, initialSync);

    // Client A inserts "Hello " at index 0
    textA.insert(0, 'Hello ');
    const updateA = Y.encodeStateAsUpdate(docA);

    // Client B concurrently inserts "World!" at index 0
    textB.insert(0, 'World!');
    const updateB = Y.encodeStateAsUpdate(docB);

    // Exchange updates
    Y.applyUpdate(docA, updateB);
    Y.applyUpdate(docB, updateA);

    // Invariant: Both documents must converge to the EXACT same string
    expect(textA.toString()).toBe(textB.toString());
    expect(textA.toString().length).toBe('Hello World!'.length);
    expect(textA.toString()).toMatch(/(Hello World!|World!Hello )/);
  });

  it('guarantees idempotency: applying duplicate updates does not alter document state', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const textA = docA.getText('content');
    const textB = docB.getText('content');

    textA.insert(0, 'Deterministic CRDT Test');
    const update = Y.encodeStateAsUpdate(docA);

    // Apply update to Doc B once
    Y.applyUpdate(docB, update);
    const firstResult = textB.toString();
    expect(firstResult).toBe('Deterministic CRDT Test');

    // Apply exact same update 5 additional times
    for (let i = 0; i < 5; i++) {
      Y.applyUpdate(docB, update);
    }

    // Invariant: Duplicate deliveries must be no-ops
    expect(textB.toString()).toBe(firstResult);
  });

  it('handles out-of-order updates correctly without state corruption', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const textA = docA.getText('content');
    const updates: Uint8Array[] = [];

    // Capture each discrete incremental update as it happens
    docA.on('update', (u) => {
      updates.push(u);
    });

    // Step 1 edit
    textA.insert(0, 'Step 1 ');
    // Step 2 edit
    textA.insert(7, 'Step 2 ');
    // Step 3 edit
    textA.insert(14, 'Step 3');

    expect(updates.length).toBe(3);

    // Deliver to Doc B in REVERSE order: update3, update2, update1
    Y.applyUpdate(docB, updates[2]);
    Y.applyUpdate(docB, updates[1]);
    Y.applyUpdate(docB, updates[0]);

    // Invariant: Commutative resolution ensures identical final string
    expect(docB.getText('content').toString()).toBe(docA.getText('content').toString());
    expect(docB.getText('content').toString()).toBe('Step 1 Step 2 Step 3');
  });

  it('converges complex TipTap XmlFragment collaborative structures', () => {
    // TipTap binds its ProseMirror document tree to Y.XmlFragment('default')
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const fragmentA = docA.getXmlFragment('default');
    const fragmentB = docB.getXmlFragment('default');

    // Client A creates paragraph with text
    const pA = new Y.XmlElement('paragraph');
    const tA = new Y.XmlText('First collaborative paragraph');
    pA.insert(0, [tA]);
    fragmentA.insert(0, [pA]);
    const updateA = Y.encodeStateAsUpdate(docA);

    // Client B concurrently creates another paragraph
    const pB = new Y.XmlElement('paragraph');
    const tB = new Y.XmlText('Concurrent second paragraph');
    pB.insert(0, [tB]);
    fragmentB.insert(0, [pB]);
    const updateB = Y.encodeStateAsUpdate(docB);

    // Cross-sync
    Y.applyUpdate(docA, updateB);
    Y.applyUpdate(docB, updateA);

    // Both document fragments must produce identical serialized representations
    expect(fragmentA.toJSON()).toEqual(fragmentB.toJSON());
    expect(fragmentA.length).toBe(2);
    expect(fragmentB.length).toBe(2);
  });
});
