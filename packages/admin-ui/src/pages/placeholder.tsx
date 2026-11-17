import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function Placeholder({ title }: { title: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>This screen arrives in a later slice.</CardDescription>
      </CardHeader>
      <CardContent />
    </Card>
  );
}
