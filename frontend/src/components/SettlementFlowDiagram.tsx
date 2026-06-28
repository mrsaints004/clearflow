import React from "react";
import type { Settlement } from "../types";

interface Props {
  settlement: Settlement;
  debtorName: string;
  dueDate?: string;
}

export default function SettlementFlowDiagram({ settlement, debtorName, dueDate }: Props) {
  const dueDateDisplay = dueDate
    ? new Date(dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "on due date";

  return (
    <div className="settlement-flow">
      <div className="flow-leg">
        <div className="flow-node flow-node-lender">{settlement.lender}</div>
        <div className="flow-arrow">
          <span className="flow-amount">${settlement.financedAmount.toLocaleString()}</span>
          <span className="flow-timing">paid now</span>
        </div>
        <div className="flow-node flow-node-seller">{settlement.seller}</div>
      </div>
      <div className="flow-leg">
        <div className="flow-node flow-node-debtor">{debtorName}</div>
        <div className="flow-arrow">
          <span className="flow-amount">${settlement.originalAmount.toLocaleString()}</span>
          <span className="flow-timing">due {dueDateDisplay}</span>
        </div>
        <div className="flow-node flow-node-lender">{settlement.lender}</div>
      </div>
    </div>
  );
}
