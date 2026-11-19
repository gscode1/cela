import { Fragment } from "react";
import { Link } from "react-router";

export interface Crumb {
  label: string;
  /** Absent for the page you are on. */
  to?: string;
}

/** One line above a detail page's title, instead of a back link: "Skills / greet". */
export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
      {items.map((item, index) => (
        <Fragment key={item.label}>
          {index > 0 && " / "}
          {item.to === undefined ? (
            <span>{item.label}</span>
          ) : (
            <Link className="underline" to={item.to}>
              {item.label}
            </Link>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
