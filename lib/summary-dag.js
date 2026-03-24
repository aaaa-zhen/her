const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./utils");

const DAG_FILE = path.join(DATA_DIR, "summary-dag.json");

const EMPTY_DAG = () => ({
  version: 1,
  nextId: 1,
  nodes: {},
  rootIds: [],
  leafIds: [],
});

function readDag() {
  try {
    if (fs.existsSync(DAG_FILE)) return JSON.parse(fs.readFileSync(DAG_FILE, "utf-8"));
  } catch (e) {}
  return EMPTY_DAG();
}

function writeDag(dag) {
  fs.writeFileSync(DAG_FILE, JSON.stringify(dag, null, 2));
}

function addLeaf(summary, tokenEstimate = 0) {
  const dag = readDag();
  const id = dag.nextId++;
  dag.nodes[id] = {
    id, depth: 0, summary, childIds: [],
    createdAt: new Date().toISOString(), tokenEstimate,
  };
  dag.leafIds.push(id);
  dag.rootIds.push(id);
  writeDag(dag);
  return id;
}

function condense(childIds, summary, tokenEstimate = 0) {
  const dag = readDag();
  const maxDepth = Math.max(...childIds.map(cid => (dag.nodes[cid] ? dag.nodes[cid].depth : 0)));
  const id = dag.nextId++;
  dag.nodes[id] = {
    id, depth: maxDepth + 1, summary, childIds,
    createdAt: new Date().toISOString(), tokenEstimate,
  };
  dag.rootIds = dag.rootIds.filter(rid => !childIds.includes(rid));
  dag.rootIds.push(id);
  writeDag(dag);
  return id;
}

function getRootSummaries() {
  const dag = readDag();
  return dag.rootIds.map(id => dag.nodes[id]).filter(Boolean).map(n => n.summary);
}

function getUncondensedLeafCount() {
  const dag = readDag();
  return dag.rootIds.filter(id => dag.nodes[id] && dag.nodes[id].depth === 0).length;
}

function getUncondensedLeafIds() {
  const dag = readDag();
  return dag.rootIds.filter(id => dag.nodes[id] && dag.nodes[id].depth === 0);
}

function isEmpty() {
  const dag = readDag();
  return dag.rootIds.length === 0;
}

function clear() {
  writeDag(EMPTY_DAG());
}

module.exports = {
  readDag, addLeaf, condense, getRootSummaries,
  getUncondensedLeafCount, getUncondensedLeafIds, isEmpty, clear,
};
